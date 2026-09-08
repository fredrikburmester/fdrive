"""Runner contract tests. Fake agy only; no network, credentials, or live workers."""

import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import unittest


RUNNER = Path(__file__).with_name("agy_worker.py").resolve()
MODULE = importlib.util.spec_from_file_location("agy_worker", RUNNER)
worker = importlib.util.module_from_spec(MODULE)
MODULE.loader.exec_module(worker)

FAKE = r'''#!/usr/bin/env python3
import json, os, pathlib, sys, time
args = sys.argv[1:]
model = args[args.index('--model') + 1]
cid = args[args.index('--conversation') + 1] if '--conversation' in args else 'test-conversation'
message = json.loads(sys.stdin.readline())['message']['content']
pathlib.Path('received.json').write_text(json.dumps({'args': args, 'prompt': message}))
if 'CASE:crash' in message:
    sys.exit(7)
print(json.dumps({'event': 'init', 'conversation_id': cid,
    'init': {'model': 'wrong' if 'CASE:model' in message else model,
             'cwd': os.getcwd(), 'permission_mode': 'request-review'}}), flush=True)
if 'CASE:hang' in message:
    time.sleep(60)
if 'CASE:malformed' in message:
    print('not-json', flush=True)
    sys.exit(0)
if 'CASE:missing' in message:
    sys.exit(0)
if 'CASE:denied' in message and 'CASE:denied_actions' not in message:
    print('Tool requires approval; soft-denied', file=sys.stderr, flush=True)
if 'CASE:tool' in message:
    print(json.dumps({'event': 'step_update', 'step_update': {'tool_info': {'error': {'type': 'permission'}}}}), flush=True)
if 'CASE:write' in message:
    pathlib.Path('worker-result.txt').write_text('fixture edit\n')
denied_actions = None
if 'CASE:denied_actions' in message:
    denied_actions = [
        'read_file(/worker/safe_file.txt)',
        'command(sh -c "secret_key=42")',
    ]
res = {'conversation_id': cid, 'status': 'ERROR' if 'CASE:error' in message else 'SUCCESS', 'response': 'done'}
if denied_actions:
    res['denied_actions'] = denied_actions
print(json.dumps({'event': 'result', 'result': res}), flush=True)
'''


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fdrive-agy-test-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / "repository with spaces"
        self.root.mkdir()
        self.env = {**os.environ, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
                    "GIT_AUTHOR_NAME": "Test", "GIT_COMMITTER_NAME": "Test",
                    "GIT_AUTHOR_EMAIL": "test@example.invalid", "GIT_COMMITTER_EMAIL": "test@example.invalid"}
        self.git("init", "-q")
        (self.root / "seed").write_text("fixture")
        roles = self.root / ".codex/agents"
        roles.mkdir(parents=True)
        for role in ("implementer", "test-writer"):
            (roles / f"{role}.toml").write_text('developer_instructions = "Run assigned tests."\n')
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        self.checkout = self.base / "worker with spaces"
        self.git("worktree", "add", "-qb", "codex/test", str(self.checkout))
        self.clean_checkout = self.base / "worker_clean"
        self.git("worktree", "add", "-qb", "codex/clean", str(self.clean_checkout))
        self.fake = self.base / "fake agy"
        self.fake.write_text(FAKE)
        self.fake.chmod(0o700)
        self.env["FDRIVE_AGY"] = str(self.fake)
        self.spec = self.base / "spec.md"
        self.jobs = []
        self.addCleanup(self.stop_jobs)

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.root), *args], env=self.env,
                              capture_output=True, text=True, check=True)

    def call(self, *args, ok=True):
        result = subprocess.run([sys.executable, str(RUNNER), "--root", str(self.root), *args],
                                env=self.env, capture_output=True, text=True, timeout=10)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        return result.stderr

    def start(self, case="write", timeout=10, **kwargs):
        self.spec.write_text(f"CASE:{case}\nOnly assigned checkout. Literal `touch nope` $(touch nope)\n")
        result = self.call("start", "--checkout", str(self.checkout), "--spec", str(self.spec),
                           "--model", "gemini-test", "--timeout", str(timeout), **kwargs)
        if isinstance(result, dict):
            self.jobs.append(result["job_id"])
        return result

    def wait(self, job_id):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            result = self.call("status", job_id)
            if not result["live"]:
                return result
            time.sleep(0.03)
        self.fail("Fixture worker did not terminate")

    def stop_jobs(self):
        for job in self.jobs:
            self.call("stop", job)
            self.wait(job)

    def test_edit_progress_and_explicit_followup(self):
        job = self.start()["job_id"]
        result = self.wait(job)
        self.assertEqual(result["status"], "needs_review")
        self.assertEqual(result["effective_model"], "gemini-test")
        self.assertEqual((self.checkout / "worker-result.txt").read_text(), "fixture edit\n")
        self.assertFalse((self.root / "worker-result.txt").exists())
        self.assertFalse((self.checkout / "nope").exists())
        received_start = json.loads((self.checkout / "received.json").read_text())
        self.assertIn("--add-dir", received_start["args"])
        self.assertEqual(received_start["args"][received_start["args"].index("--add-dir") + 1], str(self.checkout))
        self.spec.write_text("Follow-up: retain original conversation.")
        next_turn = self.call("followup", job, "--spec", str(self.spec))
        self.assertEqual(next_turn["turn"], 2)
        self.assertEqual(self.wait(job)["conversation_id"], "test-conversation")
        received = json.loads((self.checkout / "received.json").read_text())
        self.assertIn("--conversation", received["args"])
        self.assertNotIn("--continue", received["args"])
        self.assertNotIn("--dangerously-skip-permissions", received["args"])
        self.assertIn("--add-dir", received["args"])
        self.assertEqual(received["args"][received["args"].index("--add-dir") + 1], str(self.checkout))
        self.assertEqual(received["args"][received["args"].index("--print-timeout") + 1], "10s")
        self.assertIn("Never delegate", received["prompt"])
        self.assertTrue(Path(result["events"]).is_file())

    def test_terminal_failures(self):
        for case in ("crash", "missing", "model", "malformed", "error"):
            with self.subTest(case=case):
                state = self.wait(self.start(case)["job_id"])
                self.assertEqual(state["status"], "failed")

    def test_soft_denials_are_not_success(self):
        for case in ("denied", "tool"):
            with self.subTest(case=case):
                state = self.wait(self.start(case)["job_id"])
                self.assertEqual(state["status"], "needs_attention")

    def test_timeout(self):
        self.assertEqual(self.wait(self.start("hang", timeout=1)["job_id"])["status"], "timed_out")

    def test_stop_and_duplicate_checkout(self):
        job = self.start("hang")["job_id"]
        self.assertIn("already owns", self.start(ok=False))
        self.spec.write_text("followup")
        self.assertIn("active", self.call("followup", job, "--spec", str(self.spec), ok=False))
        self.assertTrue(self.call("stop", job)["stop_requested"])
        self.assertEqual(self.wait(job)["status"], "stopped")

    def test_reject_main_and_non_gemini(self):
        self.spec.write_text("task")
        common = ["start", "--spec", str(self.spec)]
        self.assertIn("separate", self.call(*common, "--checkout", str(self.root), "--model", "gemini-test", ok=False))
        self.assertIn("Gemini", self.call(*common, "--checkout", str(self.checkout), "--model", "gpt-test", ok=False))
        self.assertIn("Invalid job", self.call("status", "../escape", ok=False))

    def test_missing_binary_no_fallback(self):
        self.env["FDRIVE_AGY"] = str(self.base / "absent")
        self.assertIn("No fallback", self.start(ok=False))

    def test_pinned_model_and_effort(self):
        self.spec.write_text("CASE:write")
        result = self.call("start", "--checkout", str(self.checkout), "--spec", str(self.spec))
        self.jobs.append(result["job_id"])
        state = self.wait(result["job_id"])
        self.assertEqual(state["effective_model"], "gemini-3.8-flash-high")
        self.assertEqual(state["effort"], "high")

    def test_three_worker_limit(self):
        for index in range(3):
            self.checkout = self.base / f"worker-{index}"
            self.git("worktree", "add", "-qb", f"codex/test-{index}", str(self.checkout))
            self.start("hang")
        self.checkout = self.base / "worker-four"
        self.git("worktree", "add", "-qb", "codex/four", str(self.checkout))
        self.assertIn("At most three", self.start(ok=False))

    def test_lost_supervisor_not_restarted(self):
        job = self.start()["job_id"]
        self.wait(job)
        path = self.root / ".fdrive-workflow/agy-workers" / job / "state.json"
        state = json.loads(path.read_text())
        state["status"] = "running"
        path.write_text(json.dumps(state))
        self.assertEqual(self.call("status", job)["status"], "supervisor_lost")
        self.assertIn("lost", self.call("followup", job, "--spec", str(self.spec), ok=False))

    def test_event_contract_rejects_bypass_and_wrong_conversation(self):
        state = {"model": "gemini-test", "checkout": str(self.checkout), "conversation_id": "original"}
        with self.assertRaisesRegex(ValueError, "bypass"):
            worker.inspect_event({"event": "init", "init": {"model": "gemini-test", "cwd": str(self.checkout),
                                 "permission_mode": "always-proceed"}}, state, [])
        with self.assertRaisesRegex(ValueError, "conversation"):
            worker.inspect_event({"event": "result", "result": {"conversation_id": "different"}}, state, [])
        with self.assertRaisesRegex(ValueError, "delegation"):
            worker.inspect_event({"event": "step_update", "step_update": {"subagent_info": {"subagents": [1]}}}, state, [])

    def test_denied_actions_alone_causes_needs_attention(self):
        job = self.start("denied_actions")["job_id"]
        state = self.wait(job)
        self.assertEqual(state["status"], "needs_attention")
        self.assertIn("blocked_actions", state)
        blocked = state["blocked_actions"]
        self.assertIn("read_file(/worker/safe_file.txt)", blocked)
        self.assertIn("command([details hidden])", blocked)
        self.assertFalse(any("secret" in b for b in blocked))
        self.assertIsNone(state.get("tool_errors"))
        stderr_log = Path(state["stderr"])
        self.assertTrue(stderr_log.is_file())
        self.assertEqual(stderr_log.read_text(), "")

    def test_blocked_actions_summary_sanitization(self):
        cases = [
            ("read_file(/safe/path.txt)", ["read_file(/safe/path.txt)"]),
            ('command(sh -c "secret payload")', ["command([details hidden])"]),
            ('command(bash /script.sh --token=secret)', ["command([details hidden])"]),
            ({"action": "command", "target": 'sh -c "echo secret"'}, ["command([details hidden])"]),
            ({"tool": "run_command", "CommandLine": 'sh -c "rm -rf /"'}, ["run_command([details hidden])"]),
            ({"tool": "SECRET_TOOL_IDENTIFIER", "command": "echo 1"}, ["[details hidden]"]),
            ({"action": "SECRET_ACTION_NAME", "CommandLine": "echo 1"}, ["[details hidden]"]),
            ("malformed ::: string", ["[details hidden]"]),
            ({"unknown_dict": 123}, ["[details hidden]"]),
            (None, ["[details hidden]"]),
            (42, ["[details hidden]"]),
        ]
        for item, expected in cases:
            with self.subTest(item=item):
                self.assertEqual(worker.summarize_blocked_actions(item), expected)

    def test_recursive_delegation_detection(self):
        state = {"model": "gemini-test", "checkout": str(self.checkout), "conversation_id": "cid"}
        delegation_cases = [
            {"subagent_info": {"subagents": [1]}},
            {"tool_name": "invoke_subagent"},
            {"tool_name": "define_subagent"},
            {"tool_name": "browser_subagent"},
            {"tool_name": "task"},
            {"tool_name": "spawn_agent"},
            {"tool_calls": [{"name": "invoke_subagent"}]},
            {"tool_call": {"name": "define_subagent"}},
        ]
        for step in delegation_cases:
            with self.subTest(step=step):
                with self.assertRaisesRegex(ValueError, "delegation"):
                    worker.inspect_event({"event": "step_update", "step_update": step}, state, [])

    def test_setup_idempotence_and_preserves_config(self):
        settings_file = self.base / "settings.json"
        initial_config = {
            "custom_key": "custom_value",
            "permissions": {
                "allow": ["read_file(/existing/path)"],
                "deny": ["command(rm -rf *)"],
                "ask": ["command(pnpm install)"],
            },
        }
        settings_file.write_text(json.dumps(initial_config, indent=2))

        out1 = self.call("setup", "--checkout", str(self.clean_checkout), "--settings", str(settings_file))
        self.assertEqual(out1["status"], "configured")
        self.assertEqual(len(out1["added_grants"]), 3)
        self.assertEqual(out1["existing_grants"], [])
        self.assertIn("command(rm -rf *)", out1["deny_rules"])
        self.assertIn("command(pnpm install)", out1["ask_rules"])
        self.assertIsNotNone(out1["backup_path"])

        backup = Path(out1["backup_path"])
        self.assertTrue(backup.is_file())
        self.assertEqual((backup.stat().st_mode & 0o777), 0o400)
        self.assertEqual(json.loads(backup.read_text()), initial_config)

        # Idempotent run: no rewrite, no new backup
        out2 = self.call("setup", "--checkout", str(self.clean_checkout), "--settings", str(settings_file))
        self.assertEqual(out2["status"], "configured")
        self.assertEqual(out2["added_grants"], [])
        self.assertEqual(len(out2["existing_grants"]), 3)
        self.assertIsNone(out2["backup_path"])

        saved = json.loads(settings_file.read_text())
        self.assertEqual(saved["custom_key"], "custom_value")
        self.assertIn("read_file(/existing/path)", saved["permissions"]["allow"])
        self.assertIn("command(rm -rf *)", saved["permissions"]["deny"])
        self.assertIn("command(pnpm install)", saved["permissions"]["ask"])
        allow_grants = saved["permissions"]["allow"]
        self.assertEqual(len(allow_grants), len(set(allow_grants)))

    def test_setup_scopes_and_exact_three_grants(self):
        settings_file = self.base / "clean_settings.json"
        out = self.call("setup", "--checkout", str(self.clean_checkout), "--settings", str(settings_file))
        self.assertEqual(out["status"], "configured")
        self.assertEqual(len(out["added_grants"]), 3)
        for grant in out["added_grants"]:
            self.assertTrue(str(self.clean_checkout) in grant or re.escape(str(self.clean_checkout)) in grant)
            self.assertNotIn("*", grant)
            self.assertNotIn("--dangerously-skip-permissions", grant)

        saved = json.loads(settings_file.read_text())
        allow = saved["permissions"]["allow"]
        self.assertEqual(len(allow), 3)
        self.assertIn(f"write_file({self.clean_checkout})", allow)
        run_in = f"{self.clean_checkout}/tools/orchestration/run-in-checkout.sh"
        verify = f"{self.clean_checkout}/tools/orchestration/verify.sh"
        self.assertIn(f"command(bash {re.escape(run_in)} {re.escape(str(self.clean_checkout))} --lock --)", allow)
        self.assertIn(f"command(bash {re.escape(verify)} {re.escape(str(self.clean_checkout))})", allow)

    def test_setup_path_escaping_and_fail_closed_on_metacharacters(self):
        settings_file = self.base / "escaping_settings.json"
        initial_bytes = b'{"permissions": {"allow": []}}\n'
        settings_file.write_bytes(initial_bytes)

        # Dotted checkout: dot must be regex-escaped
        dotted = self.base / "codex.dotted.worktree"
        self.git("worktree", "add", "-qb", "codex/dotted", str(dotted))
        out = self.call("setup", "--checkout", str(dotted), "--settings", str(settings_file))
        self.assertEqual(out["status"], "configured")
        saved = json.loads(settings_file.read_text())
        allow = saved["permissions"]["allow"]
        # Verify that dot is escaped in command regex
        run_in_path = f"{dotted}/tools/orchestration/run-in-checkout.sh"
        expected_run_cmd = f"command(bash {re.escape(run_in_path)} {re.escape(str(dotted))} --lock --)"
        self.assertIn(expected_run_cmd, allow)
        # Test that the regex pattern cannot match alternate characters
        pattern = expected_run_cmd[len("command(") : -1]
        tampered_run_cmd = f"bash {str(dotted).replace('.', 'X')}/tools/orchestration/run-in-checkout.sh {dotted} --lock --"
        self.assertIsNone(re.match(pattern, tampered_run_cmd))

        # Rejected paths (whitespace, parentheses, glob characters * ? [ ] { }) must leave settings untouched
        current_settings_bytes = settings_file.read_bytes()
        rejected_paths = [
            str(self.checkout),  # whitespace
            str(self.base / "worker_paren(1)"),
            str(self.base / "worker*glob"),
            str(self.base / "worker?glob"),
            str(self.base / "worker[1]glob"),
            str(self.base / "worker{1}glob"),
        ]
        for path in rejected_paths:
            with self.subTest(path=path):
                err = self.call("setup", "--checkout", path, "--settings", str(settings_file), ok=False)
                self.assertTrue(len(err) > 0)
                self.assertEqual(settings_file.read_bytes(), current_settings_bytes)

    def test_setup_rejects_symlink_settings(self):
        real_settings = self.base / "real_settings.json"
        initial_bytes = b'{"custom": "preserved"}\n'
        real_settings.write_bytes(initial_bytes)

        # Valid symlink is rejected before exists/write and target is unchanged
        valid_symlink = self.base / "valid_symlink.json"
        valid_symlink.symlink_to(real_settings)
        err_valid = self.call("setup", "--checkout", str(self.clean_checkout), "--settings", str(valid_symlink), ok=False)
        self.assertIn("must not be a symlink", err_valid)
        self.assertEqual(real_settings.read_bytes(), initial_bytes)

        # Broken symlink is explicitly rejected before exists
        broken_symlink = self.base / "broken_symlink.json"
        broken_symlink.symlink_to(self.base / "nonexistent_target.json")
        err_broken = self.call("setup", "--checkout", str(self.clean_checkout), "--settings", str(broken_symlink), ok=False)
        self.assertIn("must not be a symlink", err_broken)

    def test_setup_rejects_main_or_foreign_checkout(self):
        settings_file = self.base / "settings.json"
        err_root = self.call("setup", "--checkout", str(self.root), "--settings", str(settings_file), ok=False)
        self.assertIn("separate linked Git worktree", err_root)

        foreign_repo = self.base / "foreign repo"
        foreign_repo.mkdir()
        subprocess.run(["git", "-C", str(foreign_repo), "init", "-q"], env=self.env, check=True)
        (foreign_repo / "seed").write_text("seed")
        subprocess.run(["git", "-C", str(foreign_repo), "add", "."], env=self.env, check=True)
        subprocess.run(["git", "-C", str(foreign_repo), "commit", "-qm", "foreign"], env=self.env, check=True)
        foreign_wt = self.base / "foreign worktree"
        subprocess.run(["git", "-C", str(foreign_repo), "worktree", "add", "-qb", "codex/foreign", str(foreign_wt)],
                       env=self.env, check=True)

        err_foreign = self.call("setup", "--checkout", str(foreign_wt), "--settings", str(settings_file), ok=False)
        self.assertIn("different repository", err_foreign)

        err_rel = self.call("setup", "--checkout", "relative/path", "--settings", str(settings_file), ok=False)
        self.assertIn("must be absolute", err_rel)

        non_codex = self.base / "non-codex worktree"
        self.git("worktree", "add", "-qb", "feature/other", str(non_codex))
        err_branch = self.call("setup", "--checkout", str(non_codex), "--settings", str(settings_file), ok=False)
        self.assertIn("branch must start with codex/", err_branch)

    def test_setup_schema_validation_and_preserves_bytes(self):
        settings_file = self.base / "invalid_schema.json"
        invalid_cases = [
            (b"{not-valid-json", "JSON"),
            (b'{"permissions": "not-a-dict"}', "permissions"),
            (b'{"permissions": {"allow": "not-a-list"}}', "list"),
            (b'{"permissions": {"allow": [123, "valid"]}}', "int"),
            (b'{"permissions": {"deny": [false]}}', "bool"),
            (b'{"permissions": {"ask": [{"nested": "dict"}]}}', "dict"),
        ]
        for content, expected_keyword in invalid_cases:
            with self.subTest(content=content):
                settings_file.write_bytes(content)
                err = self.call("setup", "--checkout", str(self.clean_checkout), "--settings", str(settings_file), ok=False)
                self.assertIn(expected_keyword, err)
                if expected_keyword == "int":
                    self.assertNotIn("123", err)
                # Ensure existing settings bytes are preserved completely untouched on failure
                self.assertEqual(settings_file.read_bytes(), content)


if __name__ == "__main__":
    unittest.main()
