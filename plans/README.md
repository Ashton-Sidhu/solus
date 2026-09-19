# Implementation plans

| Plan | Status | Dependencies |
| --- | --- | --- |
| [001 Owned server installation](001-owned-server-installation.md) | IMPLEMENTED — verification evidence in .solus-local/owned-server-qa | Current working-tree server update implementation (baseline, no migration required) |
| [002 Session message persistence](002-session-exchange.md) | DESIGN PROOF — single-table schema, SQL trace, question/steer/cancel paths; not integrated | Existing control-plane design; no dependency on plan 001 |
