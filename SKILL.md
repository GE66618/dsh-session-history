---
name: session-history
description: List and read this machine's other DeepSeek Harness conversations from the local session store (~/.dsh/sessions).
whenToUse: Use when the user refers to an earlier chat that is not in the current context ("like I said last time", "in the other window we discussed"), asks what was discussed elsewhere, or wants a recap of a past session. Read-only; transcripts are user data.
---

# session-history

DSH persists every conversation as `~/.dsh/sessions/<bucket>/session-<uuid>/session.v4.jsonl.zstd`
(`%USERPROFILE%\.dsh\sessions\...` on Windows). `<bucket>` encodes that session's workspace cwd;
every bucket is readable from any session.

## Commands

```bash
# macOS / Linux
node ~/.dsh/skills/session-history/read_sessions.mjs list --limit 30
node ~/.dsh/skills/session-history/read_sessions.mjs show <id-prefix> --chars 600
node ~/.dsh/skills/session-history/read_sessions.mjs show <id-prefix> --full
```

```powershell
# Windows
node "$env:USERPROFILE\.dsh\skills\session-history\read_sessions.mjs" list --limit 30
```

`list` prints newest-first: last activity, 8-char id prefix, user-turn count, and the session
title (LLM-generated `session/title` record, falling back to the first user message).
`show` prints user and assistant text in order; reasoning traces and tool traffic are skipped.
Session ids are UUIDs; any unique prefix works with `show`.

Needs Node.js 24+ (`zlib.zstdDecompressSync`). Set `DSH_HOME` to read a store outside `~/.dsh`.

## Transcript format notes

- The file is **many concatenated zstd frames** (one per flush) — Node's `zstdDecompressSync`
  decodes only the first frame, which makes a 1 MB transcript look like a single header line.
  `read_sessions.mjs` splits on the frame magic `28 B5 2F FD` and extends the slice when a
  candidate boundary lands inside a payload.
- Lines are JSON records: `session`, `user/message`, `assistant/message`, `tool/call`,
  `tool/result`, `session/title`, `turn/start|end`, `step/*`, `job/*`, `compaction/prune`.
- Message text lives in `data.content[]` (`type: "text"`) for user records and
  `data.message.content[]` for assistant records; `type: "reasoning"` blocks are model traces.
- Only `data.source.kind === "user"` is a typed message. Injected `runtime-context`,
  `skill-catalog`, `time-context`, `user-approval` records and tool results also arrive as
  `user/message` and must be filtered out of turn counts and transcripts.
- The in-flight turn may not be flushed yet, so the newest session can look truncated.

## Limits

- Sessions live under one user profile; other machines or OS users are not reachable.
- Files are zstd-compressed but **not encrypted**: treat this store as sensitive and never paste
  full transcripts into logs, commits, or third-party services.