"""Scoped Antigravity CLI permission management for fdrive workers."""

import contextlib
import json
import os
from pathlib import Path
import re
import tempfile
from typing import Any

DEFAULT_SETTINGS_PATH = Path.home() / ".gemini" / "antigravity-cli" / "settings.json"

KNOWN_ACTIONS = {
    "read_file",
    "write_file",
    "edit_file",
    "view_file",
    "replace_file_content",
    "run_command",
    "command",
    "read_url",
    "execute_url",
    "web_search",
    "search_web",
    "list_dir",
    "find_by_name",
    "grep_search",
    "manage_task",
    "schedule",
    "generate_image",
    "ask_question",
}


def get_scoped_grants(checkout: Path) -> list[str]:
    """Return the exact three minimal grants required for the given checkout."""
    checkout_str = str(checkout)
    if re.search(r"[\s()*?\[\]{}]", checkout_str):
        raise ValueError(
            f"Checkout path contains whitespace, parentheses, or glob metacharacters: {checkout_str}"
        )

    escaped_checkout = re.escape(checkout_str)
    run_in = f"{checkout_str}/tools/orchestration/run-in-checkout.sh"
    escaped_run_in = re.escape(run_in)
    verify = f"{checkout_str}/tools/orchestration/verify.sh"
    escaped_verify = re.escape(verify)

    return [
        f"write_file({checkout_str})",
        f"command(bash {escaped_run_in} {escaped_checkout} --lock --)",
        f"command(bash {escaped_verify} {escaped_checkout})",
    ]


def summarize_blocked_action(item: Any) -> str:
    """Summarize a single blocked action without revealing command args or payload."""
    if isinstance(item, str):
        item_str = item.strip()
        match = re.match(r"^([a-zA-Z_][a-zA-Z0-9_]*)\((.*)\)$", item_str, re.DOTALL)
        if match:
            action = match.group(1)
            target = match.group(2)
            if action not in KNOWN_ACTIONS:
                return "[details hidden]"
            if action in ("command", "run_command"):
                return f"{action}([details hidden])"
            if action in ("read_file", "write_file", "edit_file", "view_file") and not re.search(r"[\r\n\x00-\x1f]", target):
                return f"{action}({target})"
            return f"{action}([details hidden])"
        if item_str in KNOWN_ACTIONS:
            return item_str
        return "[details hidden]"
    if isinstance(item, dict):
        tool = item.get("tool") or item.get("action") or item.get("name")
        if not isinstance(tool, str) or tool not in KNOWN_ACTIONS:
            return "[details hidden]"
        if tool in ("command", "run_command") or "command" in item or "CommandLine" in item:
            return f"{tool}([details hidden])"
        path = item.get("path") or item.get("target") or item.get("AbsolutePath")
        if (
            tool in ("read_file", "write_file", "edit_file", "view_file")
            and isinstance(path, str)
            and not re.search(r"[\r\n\x00-\x1f]", path)
        ):
            return f"{tool}({path})"
        return f"{tool}([details hidden])"
    return "[details hidden]"


def summarize_blocked_actions(actions: Any) -> list[str]:
    """Convert denied action objects or strings into sanitized summary strings."""
    if not isinstance(actions, list):
        actions = [actions]
    return [summarize_blocked_action(a) for a in actions]


def detect_conflicts(existing_rules: list[str], grants: list[str], rule_type: str) -> list[dict[str, str]]:
    """Identify any deny or ask rules that could conflict with granted permissions."""
    conflicts: list[dict[str, str]] = []
    for rule in existing_rules:
        if rule == "*" or rule in ("command(*)", "write_file(*)"):
            conflicts.append({
                "rule": rule,
                "list": rule_type,
                "reason": f"Wildcard rule in {rule_type} preempts scoped worker grants",
            })
            continue
        for grant in grants:
            if rule == grant:
                conflicts.append({
                    "rule": rule,
                    "list": rule_type,
                    "reason": f"Exact rule in {rule_type} overrides allow entry for {grant}",
                })
    return conflicts


def validate_settings_schema(data: Any) -> None:
    """Validate settings permissions structure and reject non-string rule lists."""
    if not isinstance(data, dict):
        raise ValueError("Settings must be a JSON object")
    if "permissions" in data:
        perms = data["permissions"]
        if not isinstance(perms, dict):
            raise ValueError("permissions field in settings.json must be a JSON object")
        for key in ("allow", "deny", "ask"):
            if key in perms:
                rules = perms[key]
                if not isinstance(rules, list):
                    raise ValueError(f"permissions.{key} in settings.json must be a list")
                for rule in rules:
                    if not isinstance(rule, str):
                        raise ValueError(
                            f"permissions.{key} in settings.json contains non-string rule of type {type(rule).__name__}"
                        )


def configure_permissions(checkout: Path, settings_path: Path | None = None) -> dict[str, Any]:
    """
    Idempotently configure scoped permissions for the given checkout in settings.json.
    Preserves all existing settings and rules.
    Saves a private immutable backup before actual changes and writes atomically.
    On idempotent no-op, does not rewrite settings or replace backup.
    Never adds wildcard permissions or removes conflicts.
    """
    if settings_path is None:
        target_path = Path(os.path.abspath(DEFAULT_SETTINGS_PATH))
    else:
        target_path = Path(os.path.abspath(settings_path))

    if target_path.is_symlink():
        raise ValueError(f"Settings path must not be a symlink: {target_path}")

    required_grants = get_scoped_grants(checkout)

    # Validate that none of the required grants are blanket grants
    for grant in required_grants:
        if "*" in grant:
            raise ValueError(f"Blanket grant prohibited: {grant}")

    data: dict[str, Any] = {}
    raw_bytes: bytes | None = None

    if target_path.exists():
        if not target_path.is_file():
            raise ValueError(f"Settings path must be a regular file: {target_path}")
        raw_bytes = target_path.read_bytes()
        try:
            parsed = json.loads(raw_bytes.decode("utf-8"))
        except json.JSONDecodeError as err:
            raise ValueError(f"Corrupted or invalid JSON in {target_path}: {err}") from err
        validate_settings_schema(parsed)
        data = parsed

    permissions = data.setdefault("permissions", {})
    allow_list = permissions.setdefault("allow", [])
    deny_list = permissions.get("deny", [])
    ask_list = permissions.get("ask", [])

    conflicts = []
    conflicts.extend(detect_conflicts(deny_list, required_grants, "deny"))
    conflicts.extend(detect_conflicts(ask_list, required_grants, "ask"))

    added_grants = []
    existing_grants = []
    for grant in required_grants:
        if grant in allow_list:
            existing_grants.append(grant)
        else:
            added_grants.append(grant)

    # Idempotent no-op: do not rewrite settings or replace backup
    if not added_grants:
        return {
            "status": "configured",
            "checkout": str(checkout),
            "settings_path": str(target_path),
            "backup_path": None,
            "added_grants": [],
            "existing_grants": existing_grants,
            "scoped_grants": required_grants,
            "conflicts": conflicts,
            "ask_rules": ask_list,
            "deny_rules": deny_list,
        }

    target_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    backup_path: str | None = None

    # Save private immutable backup before actual modifications
    if raw_bytes is not None:
        bk_fd, bk_path = tempfile.mkstemp(
            dir=target_path.parent,
            prefix=f"{target_path.name}.bak.",
            suffix="",
        )
        try:
            with os.fdopen(bk_fd, "wb") as bf:
                bf.write(raw_bytes)
            os.chmod(bk_path, 0o400)
            backup_path = bk_path
        except Exception:
            with contextlib.suppress(OSError):
                os.unlink(bk_path)
            raise

    allow_list.extend(added_grants)

    # Atomic write to target_path using mkstemp in settings parent
    tmp_fd, tmp_path = tempfile.mkstemp(
        dir=target_path.parent,
        prefix=".settings-",
        suffix=".tmp",
    )
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as tf:
            json.dump(data, tf, indent=2)
            tf.write("\n")
        os.replace(tmp_path, target_path)
    except Exception:
        with contextlib.suppress(OSError):
            os.unlink(tmp_path)
        raise

    return {
        "status": "configured",
        "checkout": str(checkout),
        "settings_path": str(target_path),
        "backup_path": backup_path,
        "added_grants": added_grants,
        "existing_grants": existing_grants,
        "scoped_grants": required_grants,
        "conflicts": conflicts,
        "ask_rules": ask_list,
        "deny_rules": deny_list,
    }
