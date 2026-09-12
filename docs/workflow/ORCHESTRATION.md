# Multi-agent orchestration

Applies to any runtime that can spawn subagents: Claude Code's Agent tool and Codex's
`spawn_agent`. Single-agent sessions work directly in the primary checkout and can ignore this
document. Shared rules live in [WORKING.md](../../WORKING.md).

## Shared rules

- Delegate only independent work whose size justifies the handoff. Implement cohesive work
  yourself. Never delegate because a task is long; delegate because it is separable.
- Workers do not inherit this conversation. Give each one the goal, acceptance criteria,
  required checks, absolute checkout path, and file ownership in the prompt.
- Ownership is disjoint. Agree on shared interfaces before parallel work: state the
  settings/API shape and who owns which files, and notify affected workers when either changes.
- Workers preserve others' changes, stay in scope, and never delegate further, stash, or mutate
  Git state.
- Review actual worker diffs, including new files and sensitive boundaries, before integrating.
- The one-heavy-check-at-a-time rule in WORKING.md spans worktrees, not just this checkout:
  coordinate heavy checks through the primary agent, and separate concurrent browser runs by
  checkout and ports.

## Claude Code

- Use the native Agent tool with the roles in `.claude/agents/`; no custom spawning framework.
  `implementer` (code plus tests, or a tests-only assignment stated in the prompt) defaults to
  Opus; `explorer` is read-only on Sonnet.
- Fable subagents require explicit user approval for the specific scope; explain the cost and
  why Opus is insufficient. Never escalate automatically or through inheritance. The primary
  agent may itself run on Fable; that does not extend to workers.
- Delegated writes use prepared `claude/<chunk>` worktrees from `prepare-worktree.sh`.
  Transfer reviewed deltas with `transfer-checkout.sh`; commit or merge only when requested,
  and verify in the target. Keep the worker copy until transfer and verification succeed;
  never discard unreviewed work.

## Codex

- Worker model and effort are pinned in `.codex/config.toml` under `[agents]`
  (`default_subagent_model`, `default_subagent_reasoning_effort`). Subagents otherwise inherit
  the primary model, which makes a delegated chunk silently weaker or more expensive than
  intended.
- Do not pass a per-spawn `model` override to `spawn_agent`. Changing worker model or effort is
  a config change the user approves, the same way Fable escalation works for Claude Code.
- There are no role definitions: the role belongs in the spawn prompt. State the equivalent of
  `implementer` or `explorer` explicitly, say when the assignment is tests only, and name the
  tools the worker may not use.
- Codex subagents share this checkout unless you give them another. For parallel writes,
  prepare a worktree with `prepare-worktree.sh` and pass the absolute path in the prompt.
