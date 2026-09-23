# Implementation plans

| Plan | Status | Dependencies |
| --- | --- | --- |
| [001 Owned server installation](001-owned-server-installation.md) | IMPLEMENTED — verification evidence in .solus-local/owned-server-qa | Current working-tree server update implementation (baseline, no migration required) |
| [002 Session message persistence](002-session-exchange.md) | DESIGN PROOF — single-table schema, write-only-when-depended-on rule, SQL trace; not integrated | Existing control-plane design; no dependency on plan 001 |
| [003 Session message integration](003-session-message-integration.md) | PLAN — not started; four stages: fewer calls today, reliable in memory, durable messages, coordinator; decisions 1–6 need sign-off | 002 |
