# Provider seats

A seat is the login a provider CLI (Claude Code or Codex) uses for one person's
turns on a host. `packages/server/src/execution/seats/seat-manager.ts` owns the seat
directories and the `provider_seat` table.

- **The host login.** The host's owner, and the host itself, run on the host's own
  provider homes (`~/.claude`, `~/.codex`). Its state is what the CLI reports.
- **A member's seat.** Every other person on a shared host has their own directory:
  `<SOLUS_DATA_DIR>-seats/claude/<folder>` (`CLAUDE_CONFIG_DIR`) and
  `<SOLUS_DATA_DIR>-seats/codex/<folder>` (`CODEX_HOME`). The folder is named after
  the member, or is their user ID until their name is known. Credentials are per
  member; transcripts link into the host's own homes, so any member can resume a
  thread.
- **No seat, no turn.** A member with no connected seat for a provider is refused
  with `SEAT_REQUIRED` before anything starts.

## How a member's seat becomes connected

1. **A sign-in on the host.** The relayed login (`seat-connect.ts`) runs the CLI's
   own login in the member's directory and returns its URL to the client.
2. **A pasted credential.** `seatConnectToken` stores a Claude `setup-token` or a
   Codex `auth.json`.
3. **A login already in the member's directory.** When a member has no connected
   seat, and their directory holds the file the CLI writes after a sign-in
   (`.credentials.json` for Claude, `auth.json` for Codex), and the CLI's own check
   passes, the seat is connected (method `login`). The file can be in the named folder
   or in the user-ID folder; the user-ID folder then moves to the named one.
   Whatever provisions the machine can put a login there, so a member does not have
   to sign in on each host.
   - An `expired` seat is connected again only by a file written after it expired.
   - A sign-in in progress (`connecting`) is left to finish.

A seat is disconnected by `seatDisconnect`, removed with the member, or removed by
the sweep after thirty days without a turn.
