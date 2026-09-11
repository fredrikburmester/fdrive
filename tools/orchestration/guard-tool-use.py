"""PreToolUse guard: refuses the few actions WORKING.md treats as never-safe.

Reads a Claude Code PreToolUse payload on stdin. Exits 2 with a deny decision to
block the call, or 0 to leave the normal permission flow untouched. Enforcement
only; the same rules are stated in WORKING.md so they are known before an attempt.
"""

import json
import re
import sys

# Backticks are deliberately not treated as command substitution: quoting a command in
# prose (a commit message, a doc edit) is far more common than `cmd` substitution,
# and splitting on them made the guard refuse ordinary writing about these commands.
SEPARATORS = re.compile(r"\|\||&&|[;\n|]|\$\(")
ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=(?:\"[^\"]*\"|'[^']*'|\S*)\s+")
GIT_GLOBAL_WITH_VALUE = ("-C", "-c", "--git-dir", "--work-tree", "--namespace")
SESSION_LINK = re.compile(r"claude\.ai/code/session", re.I)
LOCKFILE = "pnpm-lock.yaml"


def segments(command):
    """Split a command line into candidate command positions."""
    for raw in SEPARATORS.split(command):
        segment = raw.strip().lstrip("({} \t")
        while True:
            match = ASSIGNMENT.match(segment)
            if match is None:
                break
            segment = segment[match.end():]
        if segment:
            yield segment


def git_subcommand(segment):
    """Return (subcommand, args) when the segment invokes git, else None."""
    if not re.match(r"^git\b", segment):
        return None
    tokens = segment.split()[1:]
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token in GIT_GLOBAL_WITH_VALUE:
            index += 2
            continue
        if token.startswith("-"):
            index += 1
            continue
        break
    if index >= len(tokens):
        return None
    return tokens[index], tokens[index + 1:]


SHARED_STACK = (
    "The stash stack is shared across fdrive worktrees, so %s acts on entries another worktree "
    "may own. Prefer a temporary WIP commit; if a stash is unavoidable, push with a unique tag "
    "(git stash push -m <tag>), apply by SHA, then drop that SHA."
)


def stash_violation(args):
    """Allow only the tagged, SHA-addressed stash forms WORKING.md permits."""
    action = args[0] if args else ""
    if action in ("list", "show"):
        return None
    if action == "clear":
        return SHARED_STACK % "git stash clear"
    if action in ("push", "save"):
        if any(a in ("-m", "--message") or a.startswith("--message=") for a in args[1:]):
            return None
        return SHARED_STACK % "an untagged git stash push"
    if action in ("apply", "drop", "pop"):
        if action != "pop" and len(args) > 1:
            return None
        return SHARED_STACK % ("git stash " + action + " without an explicit SHA")
    return SHARED_STACK % "a bare git stash"


def git_violation(segment):
    parsed = git_subcommand(segment)
    if parsed is None:
        return None
    subcommand, args = parsed
    if subcommand == "stash":
        return stash_violation(args)
    if subcommand == "reset" and "--hard" in args:
        return "`git reset --hard` discards uncommitted work. Commit or transfer it first."
    if subcommand == "clean":
        forced = any(
            argument.startswith("-") and "f" in argument.lstrip("-").split("=")[0]
            for argument in args
        )
        if forced:
            return "`git clean -f` deletes untracked files, including unreviewed worker output."
    if subcommand == "push" and any(a in ("--force", "-f") for a in args):
        return "`git push --force` is blocked. Use --force-with-lease if a rewrite is genuinely required."
    return None


def bash_violation(command):
    if SESSION_LINK.search(command):
        return "Claude session links must never be published. Remove the claude.ai/code/session URL."
    for segment in segments(command):
        reason = git_violation(segment)
        if reason is not None:
            return reason
    return None


def edit_violation(tool_input):
    path = tool_input.get("file_path") or tool_input.get("notebook_path") or ""
    if path.endswith(LOCKFILE):
        return (
            f"{LOCKFILE} must never be hand-edited. Change the manifest and let pnpm regenerate it."
        )
    return None


def main():
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return 0
    tool_name = payload.get("tool_name", "")
    tool_input = payload.get("tool_input") or {}
    if not isinstance(tool_input, dict):
        return 0

    if tool_name == "Bash":
        reason = bash_violation(str(tool_input.get("command", "")))
    elif tool_name in ("Edit", "Write", "NotebookEdit"):
        reason = edit_violation(tool_input)
    else:
        reason = None

    if reason is None:
        return 0

    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": reason,
            }
        },
        sys.stdout,
    )
    sys.stdout.write("\n")
    return 2


if __name__ == "__main__":
    sys.exit(main())
