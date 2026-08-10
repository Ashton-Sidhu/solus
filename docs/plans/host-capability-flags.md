# Host Capability Flags — hosts advertise what they support

**Goal:** a client never shows an action a host cannot perform, and never sends a
request an older host does not understand. Capability is data the host advertises,
not a guess the client derives from "is this host local" or "did this RPC fail".
Absent capability = unsupported = the action is hidden or gated with a reason.

**Status: ready to implement.** Decisions are recorded below. This is WP7 item 1 of
[multi-host-parity.md](./multi-host-parity.md); WP1–WP6 of that plan are implemented
in the tree and this plan builds on their primitives.

- **Decisions**: [ADR-0008](../adr/0008-the-renderer-addresses-hosts-not-an-ambient-api.md)
  (host-addressed API), [ADR-0009](../adr/0009-every-domain-declares-its-host-ownership.md)
  (gated-local class; this plan gives that class its mechanism).
- **Prior art**: T3 Code's `ExecutionEnvironmentCapabilities` — each flag documents
  "absent on older servers, so clients hide the action instead of sending it".
- **Executing-agent note**: the working tree carries the uncommitted multi-host
  series. Read `docs/plans/multi-host-parity.md` status headers first, and verify
  current-state claims below with grep before editing — do not trust line numbers.

## Context

The multi-host series (WP1–WP6) made every renderer call name its host, but
"can this host do X" is still answered three ad-hoc ways:

1. **Client-machine policy checks**: `serverId === LOCAL_SERVER_ID` gates for
   terminal (`ActionOrb.svelte`, `git-actions.svelte.ts`), open-in-editor
   (`lib/openExternalEditor.ts`), reveal-in-Finder (`DirectoryPicker.svelte`).
   These are correct policy (the action targets the *client's* machine) but each
   site re-derives it.
2. **Desktop-shell checks**: `desktopHandlersAvailable`-style probes for
   native-only surfaces.
3. **Nothing at all** for version skew: a WP4+ client calling `attachUpload`,
   `assetCreateUrl`, or the federated automation RPCs against an older standalone
   server gets a raw "unknown method" failure surfaced as a generic error.

Two different questions are being conflated:

- **"Is this action about my machine?"** — client policy; stays a local check but
  moves behind one helper.
- **"Does this host support this feature?"** — the host's fact to advertise; today
  nobody answers it.

## Decisions

1. **Capabilities travel over an authenticated RPC, not `/health`.** `/health` is
   public CORS (`src/main/server/http.ts`) and stays minimal (`ok`,
   `installationId`, `name`, `claimable`). A new `serverGetCapabilities()` RPC
   returns the typed record. Rationale: capability detail (editor list, feature
   surface) has no business being unauthenticated, and the RPC path already has
   typing, transports, and caching conventions.
2. **The record is a flat map of named booleans plus small typed payloads**, e.g.
   `{ attachUpload: true, assetUrls: true, skillsInstall: true, voiceModel: true,
   editors: ['vscode', 'cursor'], … }`. Unknown keys are ignored by the client;
   **absent keys mean unsupported** (version-skew safe in both directions). No
   version numbers, no semver comparisons — capabilities only.
3. **The old server is the baseline.** A host that does not implement
   `serverGetCapabilities` at all (RPC error) yields the empty record — every
   gated feature hides. This is the T3 rule: never send a request the host did not
   advertise.
4. **Client-machine policy stays separate.** A single `hostPolicy` helper answers
   "is this host the client's machine" (wrapping the existing
   `LOCAL_SERVER_ID`/resolveId logic); gated-local actions combine
   `hostPolicy.isClientMachine(serverId) && capability`. Do not fold policy into
   the capability record — a remote host *having* an editor does not make
   "open in editor" useful here.

## Work packages

### WP-A — Contract and host side

- `src/shared/rpc.ts` + `src/shared/types.ts`: `serverGetCapabilities` method and
  a `HostCapabilities` type. Follow the Contracts rule: server handler, preload
  (`src/preload/index.ts`), both transports.
- Handler (new `src/main/server/handlers/capability-handlers.ts` or the existing
  server-info handler if one fits): assemble the record from what this build
  actually supports. Initial flags, derived from the WP4/WP6 surfaces:
  - `attachUpload`, `assetUrls` (WP4 RPC + HTTP route present)
  - `skillsInstall`, `skillsSearch` (skills CLI available on this host)
  - `voiceModel` (voice model download/status surface)
  - `automations` (automation store/scheduler present)
  - `editors: string[]` (from the existing `detectEditors` detection, host-side)
  - `githubProvider` (GitHub provider wiring present — NOT whether a token is
    connected; auth state stays a runtime error + inline connect per ADR-0009)
- Keep assembly cheap and synchronous where possible; editor detection may reuse
  the existing cached detection path.

### WP-B — Client cache and helper

- `ServerConnections` gains a `capabilitiesFor(serverId)` async accessor with the
  same cache shape as `probeHealth` (TTL + invalidation on reconnect generation —
  a reconnected host may have been upgraded). RPC failure → empty record, cached
  briefly, never thrown to features.
- One sync read path for renderer gating: `capability(serverId, key)` returning
  `boolean | undefined` from the cache (undefined = not yet known → treat as
  unsupported for hiding, but let surfaces show a loading state where they
  already have one).
- `hostPolicy.isClientMachine(serverId)` helper in `src/client-core/`; migrate the
  existing gates (`ActionOrb`, `git-actions`, `openExternalEditor`,
  `DirectoryPicker` reveal) to it. Pure moves — no behavior change.

### WP-C — Renderer gating sweep

Wire capabilities into the surfaces that currently fail raw against older hosts:

- Attachment upload path (WP4): remote session on a host without `attachUpload` →
  the composer disables non-image attach for that session with a tooltip reason
  (gated pattern), instead of a failed RPC at send time.
- Artifact/image rendering (WP4): host without `assetUrls` → keep the current
  graceful img-error state but add the reason to the artifact error card.
- Settings tabs (WP6 host selectors): Skills/Tools/Voice tabs consult the selected
  host's capabilities; a host without the surface shows the tab's empty state
  with "not supported on <host>" copy instead of erroring.
- Automation builder host choice: hosts without `automations` are excluded from
  the picker.
- Editor picking: `editors` comes from the capability record for the *relevant*
  host; open-in-editor remains client-machine-gated via `hostPolicy`.

### WP-D — Tests and docs

- Unit tests: capability cache (TTL, reconnect invalidation, failure → empty),
  absent-key = unsupported, one gating decision per surface family (pure
  functions where possible).
- ADR-0009 gets one line added to the gated-local row pointing at
  `hostPolicy` + capabilities as the mechanism. `multi-host-parity.md` §WP7 marks
  item 1 as planned-out here.

## Hard rules for the executing agent

- Contracts rule in full for the new RPC. No `as HostApi`/`as any` outside
  `src/client-core` (`bun run lint:hosts` enforces).
- Additive only — no removal of existing runtime error handling; capabilities
  gate proactively, errors still handle the races.
- Single-host desktop behavior unchanged (the local host advertises everything
  its build supports; all current features remain visible).
- Svelte 5 house rules; durable state through stores.

## Verification gates

- `bunx svelte-check --tsconfig ./tsconfig.json` ≤ 219 errors, zero new; combined
  check (temp tsconfig including `client/src`) ≤ 293, zero new.
- `bun run lint:hosts` zero violations; `bun run build` green.
- Distinct unit failures ≤ 82
  (`bun test tests/unit 2>&1 | grep "(fail)" | sed 's/\[[0-9.]*ms\]//' | sort -u | wc -l`).
- Focused capability tests green.

## Out of scope

- Auth/token state as a capability (stays runtime + inline connect, ADR-0009).
- Any relay/cloud component. Any provider (Claude/Codex) capability negotiation.
- Removing runtime error paths that capabilities now pre-empt.

## Implementation status

**Implemented 2026-08-10.** WP-A through WP-D are complete. The shipped record
advertises `attachUpload`, `assetUrls`, `skillsInstall`, `skillsSearch`,
`voiceModel`, `automations`, `editors`, and `githubProvider`. Successful records
cache for 60 seconds; an older host's unknown-method failure becomes an empty
record cached for 5 seconds. Reconnect generations invalidate the record.

Final checks:

- `bun run lint:hosts`: 0 violations.
- `bun run build`: passed.
- Source Svelte check: 218 errors / 32 warnings (baseline 219 / 32); no new
  diagnostics in changed files.
- Client-inclusive Svelte check: 253 errors / 32 warnings (baseline 253 / 32);
  no new diagnostics in changed files.
- Focused capability and adjacent tests: 23 passed, 0 failed.
- Full unit-suite distinct failures: 82 (captured baseline 81; plan ceiling 82).
  The added distinct failure is outside the capability domain in the concurrently
  changing tree; every capability-domain test is green.

Deviations and judgments:

- The existing `client/tsconfig.json` already includes `client/src`, renderer,
  shared, and client-core, so it served as the combined check instead of creating
  a duplicate temporary config.
- Hosts without the `detectEditors` handler omit `editors` rather than advertise
  an empty list. This preserves the rule that absence means the Tools surface is
  unsupported, while a supported host with no detected editor advertises `[]`.
- No interactive browser or app run was performed, per the repository safety
  rule. Build, type diagnostics, host lint, and focused tests are the verification.
