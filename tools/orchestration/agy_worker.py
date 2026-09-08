"""Durable agy jobs. Standard library only, Python 3.11+, macOS/Linux."""

import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import queue
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import tomllib
import uuid


ROOT = Path(__file__).resolve().parents[2]
ACTIVE = {"starting", "running"}
MAX_EVENT_BYTES = 1024 * 1024
DELEGATION_TOOLS = {
    "task",
    "spawn_agent",
    "invoke_subagent",
    "define_subagent",
    "browser_subagent",
}

sys.path.insert(0, str(Path(__file__).resolve().parent))
from agy_permissions import configure_permissions, summarize_blocked_actions


def read_json(path):
    return json.loads(path.read_text())


def write_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def private_dir(path):
    if path.is_symlink():
        raise ValueError(f"State directory must not be a symlink: {path}")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    return path


def registry(root):
    return private_dir(private_dir(root / ".fdrive-workflow") / "agy-workers")


def git(checkout, *args):
    return subprocess.check_output(
        ["git", "-C", str(checkout), *args], text=True, stderr=subprocess.PIPE
    ).strip()


def validate_checkout(root, value):
    path = Path(value)
    if not path.is_absolute():
        raise ValueError("--checkout must be absolute")
    path = path.resolve(strict=True)
    if path == root or not (path / ".git").is_file():
        raise ValueError("Worker must use a separate linked Git worktree")
    if Path(git(path, "rev-parse", "--show-toplevel")).resolve() != path:
        raise ValueError("--checkout must name the worktree root")
    common = Path(git(path, "rev-parse", "--path-format=absolute", "--git-common-dir"))
    expected = Path(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"))
    if common.resolve() != expected.resolve():
        raise ValueError("Worker worktree belongs to a different repository")
    if not git(path, "branch", "--show-current").startswith("codex/"):
        raise ValueError("Worker branch must start with codex/")
    return path


def spec_text(value):
    path = Path(value)
    if not path.is_absolute() or not path.is_file():
        raise ValueError("--spec must name an absolute existing file")
    if path.stat().st_size > MAX_EVENT_BYTES:
        raise ValueError("Worker spec exceeds 1 MiB")
    text = path.read_text()
    if not text.strip():
        raise ValueError("Worker spec is empty")
    return text


def job_dir(base, job_id):
    if not re.fullmatch(r"[0-9a-f]{32}", job_id):
        raise ValueError("Invalid job ID")
    path = base / job_id
    if path.is_symlink() or not path.is_dir():
        raise ValueError("Unknown job ID")
    return path


def live(path):
    # The supervisor inherits this flock. No PID reuse assumptions or stale heartbeat guesses.
    with (path / "lease").open("rb") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        fcntl.flock(handle, fcntl.LOCK_UN)
        return False


def snapshot(path):
    state = read_json(path / "state.json")
    state["live"] = live(path)
    if state["status"] in ACTIVE and not state["live"]:
        state["status"] = "supervisor_lost"
    return state


@contextlib.contextmanager
def registry_lock(base):
    with (base / "registry.lock").open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def worker_prompt(root, config, spec):
    role = tomllib.loads((root / ".codex/agents" / f"{config['role']}.toml").read_text())
    instructions = role["developer_instructions"]
    return (
        f"You are the {config['role']} worker, running Gemini through agy.\n"
        f"Your only checkout: {config['checkout']}\n"
        "Never delegate, stash, commit, merge, or run Git mutations. You are not alone; "
        "preserve others' changes. Stay within the spec's owned paths. "
        "Run required checks using the repository's locked helpers. "
        "Report changed files, commands and results, denied tools, and remaining work. "
        "Do not claim completion when commands were denied.\n\n"
        f"Role instructions:\n{instructions}\n\nTask specification:\n{spec}"
    )


def launch(root, base, args):
    text = spec_text(args.spec)
    with registry_lock(base):
        if args.command == "start":
            if not re.fullmatch(r"gemini-[a-zA-Z0-9._-]+", args.model):
                raise ValueError("--model must be an explicit Gemini slug from agy models")
            checkout = validate_checkout(root, args.checkout)
            executable = shutil.which(os.environ.get("FDRIVE_AGY", "agy"))
            if executable is None:
                raise ValueError("agy not found; install/authenticate agy first. No fallback.")
            config = {
                "checkout": str(checkout), "model": args.model, "effort": args.effort,
                "role": args.role, "executable": str(Path(executable).resolve()),
                "timeout_seconds": args.timeout,
            }
            previous = None
        else:
            path = job_dir(base, args.job_id)
            previous = snapshot(path)
            if previous["live"] or previous["status"] == "supervisor_lost":
                raise ValueError("Job is active or lost; inspect its process before continuing")
            if not previous.get("conversation_id"):
                raise ValueError("No conversation ID to resume; create a new job explicitly")
            config = read_json(path / "config.json")
            validate_checkout(root, config["checkout"])

        for candidate in base.iterdir():
            if candidate.is_dir() and re.fullmatch(r"[0-9a-f]{32}", candidate.name):
                state = snapshot(candidate)
                if state["status"] == "supervisor_lost":
                    raise ValueError(f"Unresolved lost supervisor: {candidate.name}")
                if state["live"] and state["checkout"] == config["checkout"]:
                    raise ValueError("A worker already owns that checkout")
        active_count = sum(
            live(p) for p in base.iterdir()
            if p.is_dir() and re.fullmatch(r"[0-9a-f]{32}", p.name)
        )
        if active_count >= 3:
            raise ValueError("At most three agy workers may run simultaneously")

        prompt = worker_prompt(root, config, text)
        if previous is None:
            path = private_dir(base / uuid.uuid4().hex)
            write_json(path / "config.json", config)
            (path / "lease").touch(mode=0o600)
        turn = 1 if previous is None else previous["turn"] + 1
        run = private_dir(path / f"turn-{turn}")
        (run / "prompt.txt").write_text(prompt)
        state = {
            "job_id": path.name, "checkout": config["checkout"], "model": config["model"],
            "effort": config["effort"], "role": config["role"], "turn": turn,
            "status": "starting", "conversation_id": previous.get("conversation_id") if previous else None,
            "events": str(run / "events.jsonl"), "stderr": str(run / "stderr.log"),
            "started_at": time.time(), "review_required": True,
        }
        write_json(path / "state.json", state)
        lease = (path / "lease").open("r+")
        fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            with (run / "supervisor.log").open("wb") as log:
                process = subprocess.Popen(
                    [sys.executable, str(Path(__file__).resolve()), "_supervise", str(path), str(lease.fileno())],
                    stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True,
                    pass_fds=(lease.fileno(),),
                )
            state["supervisor_pid"] = process.pid
            # Supervisor is the sole state writer after launch; return PID without racing its updates.
        except Exception:
            state["status"] = "launch_failed"
            write_json(path / "state.json", state)
            raise
        finally:
            lease.close()
        return state


def inspect_event(event, state, results):
    if not isinstance(event, dict):
        raise ValueError("Event must be a JSON object")
    kind = event.get("event")
    if kind == "init":
        config = event.get("init", {})
        if config.get("model") != state["model"]:
            raise ValueError("agy did not confirm the requested model")
        if Path(config.get("cwd", "")).resolve() != Path(state["checkout"]):
            raise ValueError("agy initialized the wrong checkout")
        if config.get("permission_mode") == "always-proceed":
            raise ValueError("Blanket permission bypass is not allowed")
        state["effective_model"] = config["model"]
        state["init_seen"] = True
        conversation = event.get("conversation_id")
        if not isinstance(conversation, str) or not conversation:
            raise ValueError("Missing conversation ID")
        if state["conversation_id"] not in (None, conversation):
            raise ValueError("agy resumed the wrong conversation")
        state["conversation_id"] = conversation
    elif kind == "step_update":
        step = event.get("step_update", {})
        tool_name = (
            step.get("tool_name")
            or step.get("tool_info", {}).get("name")
            or step.get("tool_call", {}).get("name")
        )
        tool_calls = step.get("tool_calls") or []
        tc_names = [tc.get("name") for tc in tool_calls if isinstance(tc, dict)] if isinstance(tool_calls, list) else []
        if (
            step.get("subagent_info")
            or tool_name in DELEGATION_TOOLS
            or any(t in DELEGATION_TOOLS for t in tc_names)
        ):
            raise ValueError("Worker attempted recursive delegation")
        error = step.get("tool_info", {}).get("error")
        if error:
            state["tool_errors"] = state.get("tool_errors", 0) + 1
        state["last_step"] = {key: step[key] for key in ("step_index", "state", "step_type", "tool_name") if key in step}
    elif kind == "result":
        result = event.get("result")
        if not isinstance(result, dict) or results:
            raise ValueError("Expected exactly one terminal result per turn")
        if result.get("conversation_id") != state["conversation_id"]:
            raise ValueError("Result conversation mismatch")
        results.append(result)
        denied = result.get("denied_actions") or result.get("deniedActions")
        if denied:
            state["blocked_actions"] = summarize_blocked_actions(denied)


def terminate(process):
    # Signal only a process group created by this supervisor, never a PID loaded from disk.
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            return
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            continue
        # Kill descendants which survived the leader before releasing ownership.
        if sig == signal.SIGTERM:
            continue


def supervise(path, lease_fd):
    state = read_json(path / "state.json")
    config = read_json(path / "config.json")
    run = path / f"turn-{state['turn']}"
    process = None
    results = []
    events = queue.Queue()
    state["supervisor_pid"] = os.getpid()
    stop_requested = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop_requested.set())

    def read_events(pipe):
        try:
            while line := pipe.readline(MAX_EVENT_BYTES + 1):
                if len(line) > MAX_EVENT_BYTES:
                    events.put(ValueError("agy event exceeds 1 MiB"))
                    break
                events.put(line)
        except Exception as error:
            events.put(error)
        finally:
            events.put(None)

    try:
        args = [config["executable"], "--model", config["model"], "--effort", config["effort"],
                "--mode", "accept-edits", "--disable-slash-commands",
                "--print-timeout", f"{config['timeout_seconds']}s",
                "--input-format", "stream-json", "--output-format", "stream-json",
                "--add-dir", config["checkout"]]
        if state["conversation_id"]:
            args.extend(["--conversation", state["conversation_id"]])
        with (run / "stderr.log").open("wb") as err, (run / "events.jsonl").open("wb") as log:
            process = subprocess.Popen(args, cwd=config["checkout"], stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=err, start_new_session=True)
            state.update(status="running", pid=process.pid)
            write_json(path / "state.json", state)
            reader = threading.Thread(target=read_events, args=(process.stdout,), daemon=True)
            reader.start()
            message = {"event": "user", "message": {"content": (run / "prompt.txt").read_text()}}
            def send_prompt():
                try:
                    process.stdin.write((json.dumps(message) + "\n").encode())
                    process.stdin.close()
                except OSError as error:
                    events.put(error)

            threading.Thread(target=send_prompt, daemon=True).start()
            deadline = time.monotonic() + config["timeout_seconds"]
            eof = False
            while not eof or process.poll() is None:
                if stop_requested.is_set() or (run / "stop").exists():
                    state["status"] = "stopped"
                    break
                if time.monotonic() >= deadline:
                    state["status"] = "timed_out"
                    break
                try:
                    item = events.get(timeout=0.1)
                except queue.Empty:
                    continue
                if item is None:
                    eof = True
                elif isinstance(item, Exception):
                    raise item
                else:
                    log.write(item)
                    log.flush()
                    inspect_event(json.loads(item), state, results)
                    write_json(path / "state.json", state)
            if state["status"] == "running":
                state["exit_code"] = process.wait()
                if state["exit_code"] != 0 or not state.get("init_seen") or len(results) != 1:
                    state["status"] = "failed"
                elif results[0].get("status") != "SUCCESS":
                    state["status"] = "failed"
                else:
                    state["status"] = "needs_review"
                    diagnostics = (run / "stderr.log").read_text(errors="replace")
                    has_denied = bool(
                        state.get("blocked_actions")
                        or (results and (results[0].get("denied_actions") or results[0].get("deniedActions")))
                    )
                    if (
                        state.get("tool_errors")
                        or has_denied
                        or re.search(
                            r"soft.denied|permission.{0,30}denied|requires approval", diagnostics, re.I
                        )
                    ):
                        state["status"] = "needs_attention"
            if results:
                write_json(run / "result.json", results[0])
                state["result"] = str(run / "result.json")
                state["agy_status"] = results[0].get("status")
                denied = results[0].get("denied_actions") or results[0].get("deniedActions")
                if denied and "blocked_actions" not in state:
                    state["blocked_actions"] = summarize_blocked_actions(denied)
    except Exception as error:
        state.update(status="failed", error=str(error))
    finally:
        if process is not None:
            terminate(process)
            state["exit_code"] = process.returncode
        state["finished_at"] = time.time()
        write_json(run / "state.json", state)
        write_json(path / "state.json", state)
        os.close(lease_fd)


def main():
    os.umask(0o077)
    if len(sys.argv) == 4 and sys.argv[1] == "_supervise":
        supervise(Path(sys.argv[2]), int(sys.argv[3]))
        return
    defaults = read_json(Path(__file__).with_name("agy-worker-defaults.json"))
    parser = argparse.ArgumentParser(description="Isolated Gemini workers via agy; no GPT fallback")
    parser.add_argument("--root", type=Path, default=ROOT, help="Repository owning the worker registry")
    commands = parser.add_subparsers(dest="command", required=True)
    setup = commands.add_parser("setup", help="Configure scoped permissions for a worker worktree")
    setup.add_argument("--checkout", required=True, help="Absolute path to worker worktree")
    setup.add_argument("--settings", type=Path, default=None, help="Injectable settings path for offline tests")
    start = commands.add_parser("start")
    start.add_argument("--checkout", required=True)
    start.add_argument("--spec", required=True)
    start.add_argument("--model", default=defaults["model"], help="Explicit override of the pinned Gemini model")
    start.add_argument("--role", choices=("implementer", "test-writer"), default="implementer")
    start.add_argument("--effort", choices=("low", "medium", "high"), default=defaults["effort"])
    start.add_argument("--timeout", type=int, default=1800, help="Turn timeout in seconds")
    for name in ("status", "stop", "followup"):
        command = commands.add_parser(name)
        command.add_argument("job_id")
        if name == "followup":
            command.add_argument("--spec", required=True)
    args = parser.parse_args()
    if args.command == "start" and not 1 <= args.timeout <= 43200:
        parser.error("--timeout must be between 1 and 43200 seconds")
    try:
        root = args.root.resolve(strict=True)
        if args.command == "setup":
            checkout = validate_checkout(root, args.checkout)
            result = configure_permissions(checkout, args.settings)
            print(json.dumps(result))
            return
        base = registry(root)
        if args.command in ("start", "followup"):
            result = launch(root, base, args)
        else:
            with registry_lock(base):
                path = job_dir(base, args.job_id)
                result = snapshot(path)
                if args.command == "stop" and result["live"]:
                    (path / f"turn-{result['turn']}" / "stop").touch(mode=0o600)
                    result["stop_requested"] = True
        print(json.dumps(result))
    except (ValueError, OSError, subprocess.SubprocessError, KeyError) as error:
        parser.exit(1, f"worker: {error}\n")


if __name__ == "__main__":
    main()
