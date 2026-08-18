# First-run onboarding

The one pass a fresh client makes before the workspace opens. Adapted from the
`Onboarding.dc.html` design in the Solus Claude Design project.

## Vocabulary — lock this before changing anything

| Term | Means |
|---|---|
| **first-run onboarding** | This flow. Client-scoped, once per install. |
| **host onboarding** | The *other* thing: `HostOnboarding.svelte`, the rail a **host** arrives through. Unrelated, and not a synonym. |
| **stage** | One screen of the flow: `intro`, `shortcuts`, `getting-around`, `agents`, `providers`, `host`, `start`. |
| **asking stage** | Everything but `intro` — the ones the user can move between. |
| **surface** | `pointer` or `touch`. Which stage list this client gets. |
| **mode** | `project` or `chat`. What the `start` stage decided, and the only thing the flow hands to the workspace. |

Do not coin "step", "screen", "page" or "wizard" for a stage, and do not use "setup"
unqualified: `HostSetupSession` already owns that word for installs on a host. A surface is
`pointer` or `touch` — not "desktop", "web" or "mobile", which name shells rather than the
thing the flow branches on.

## Shape

```
pointer  intro ──▶ shortcuts ──────▶ agents ──▶ providers ──▶ start ──┬─ project ──▶ new-tab home + folder picker
touch    intro ──▶ getting-around ──▶ host ───────────────────▶ start ──┘   chat ──▶ new-tab home
```

Every asking stage is the same shape — a centred title, a column of washed rows, and a
quiet Continue/Skip pair. There is no rail, no footer, no step numbering and no summary:
the flow is short enough to hold in the head, and each stage already reports its own state.

`start` is last because it is the only stage that decides where the user lands. Answering
it *is* the finish: nothing may be inserted after it, on either surface.

## Two surfaces, and why not three

`surfaceFor` reads `runtime`: touch-only — a coarse pointer with no fine pointer anywhere —
gets `touch`; everything else gets `pointer`.

The split is deliberately *not* desktop-versus-web. A browser on a laptop has the same
keyboard and the same room as the desktop app, so it keeps the keys; an iPad with a Magic
Keyboard reports a fine pointer and keeps them too. What the flow branches on is whether
there is anything to press. The one web-shaped difference is inside the shortcuts stage,
not the stage list: `onboardingKeysFor(IS_WEB)` teaches a different seven, because the web
shell has no Pill mode to leave and no desktop command palette.

The surface is captured once in `store.start()` and then fixed. Deriving it live would swap
the stage list out from under the stage the user is standing on when a keyboard is attached
or a window is dragged onto a touch screen.

What the touch flow drops, and why:

| Pointer stage | On touch | Why |
|---|---|---|
| `shortcuts` | becomes `getting-around` | Seven ⌘-combos and an invitation to press one are worth nothing to a thumb. The gestures it teaches instead are the ones `WebMobileLayout` already answers to: the left-edge swipe, the title tap, the composer's `+`, and Back unwinding the overlay stack. |
| `agents` + `providers` | collapse into `host` | Both ask about a *remote* machine's setup, usually one already set up from its own desktop. One stage reports where that machine stands and asks only about what is missing. A ready host is a sentence and one check mark, not two screens. |
| Cloudflare | dropped | The one connection with no browser handshake to hand off to: it wants a scoped API token pasted in. That is a bad thing to ask of a thumb, and it is never blocking. Settings still has it. |

The `host` stage also carries the one thing a phone user has to understand and no other
stage says: agents run on the host, not on the device, so closing the tab does not stop
them.

`OnboardingAgentRow` and `OnboardingGithubRow` are shared by both flows, so the pointer and
touch stages drive the same setup session and the same device flow and can never disagree
about where a host stands. The agent row's sign-in copy is the one place `store.surface` is
read for wording: on touch the CLI's browser opens on the *host*, so "it opened your
browser" would send a phone user looking for a window that was never going to appear.

## Landing

Both modes land on the workspace's new-tab home, which is what an unstarted tab already
renders — so `chat` opens nothing. `project` additionally dispatches
`solus:open-directory-picker` on `window`, the same event the new-tab home itself uses.
That is why the hand-off needs no props and no per-shell wiring: desktop and web both
already listen for it.

Two things the design drew that are deliberately absent:

- **A first-task stage** that ran a live agent turn inside onboarding. It would have
  duplicated the conversation view inside a surface the user is about to leave.
- **A project stage** with recents, browse and clone. The workspace's own folder picker
  does this, and doing it twice meant two lists that could disagree.

## Where the truth lives

Nothing in this flow keeps its own copy of anything durable.

| Stage | Reads and writes |
|---|---|
| `agents` | `hostSetupStore.sessionFor(activeServerId)` and `codingProviderRows` — the same engine and read model as the Settings host page. Install and sign-in are one action per agent. |
| `providers` | `connectionsStore` for GitHub's device flow; `cloudflareStore` plus `CloudflareConnectForm` for the pasted API token. Both are the app's real connections, so anything connected here is connected in Settings. |
| `shortcuts` | `KEYBINDINGS` plus the dispatcher's overrides. The caps are the combos the app answers to, never literals. |
| `host` | The same `hostSetupStore` session and `connectionsStore` as the two stages it replaces, plus `serversStore.activeServer` for the machine's name. |
| `getting-around` | Nothing durable. `ONBOARDING_GESTURES` is a literal list, kept honest by review against `WebMobileLayout` rather than by a table it can read. |

`onboardingStore` holds only flow state: the stage, the greeting, and the chosen mode.

## Completion is a client preference

`settings.onboardingCompleted` lives in the settings blob, because onboarding teaches
*this client's* interface — a phone and a desktop each deserve their own pass, and neither
is a property of the host.

The absence of the whole settings blob is what means "fresh install". A saved blob without
the key defaults to `true`: it belongs to someone who was already working here before this
flow existed, and they are not ambushed with it on upgrade.

## Motion

Every shared animation lives in `index.css` under "First-run onboarding motion", not in
each stage's `<style>` block — four stages had identical copies and the perf fix had to be
made four times.

**Transform and opacity only.** The first pass animated `filter: blur()` on every entering
element and `left`/`width` on the progress sweep, which is why it dropped frames: a blur
re-rasterizes each element on every frame, and `left`/`width` relayouts the row. Neither
belongs in a keyframe. The sweep is now a fixed-width bar translated across its clip.

`OnboardingMark` is the exception that proves the rule. Its two layers scale to 26× and
64×, and both declare `will-change: transform` — that is load-bearing, not decoration.
Without it the compositor re-rasterizes the artwork as it grows, and a 64× ring is a very
expensive raster; with it the layer is rastered once and only the texture is transformed.
The mark is unmounted after the greeting, so the promoted layer does not linger.

The mark is two layers rather than one scaled `WorkspaceMark` because they move
differently: the core comes at the viewer while the rings break away faster, further, and
fade out first, so they clear the screen edges ahead of it.

## Constraints that are easy to break

- **The exclusive keybinding scope is load-bearing.** The shortcuts stage invites the user
  to press ⌘K. Without `pushScope('onboarding', true)` the real command palette opens
  behind the overlay. The scope is deliberately empty — an exclusive scope with no
  bindings blocks everything under it.
- **Enter answers only `shortcuts`, `getting-around` and `start`.** The agents and providers
  stages dim Continue until something is connected; a keystroke that walks past a gate the
  button honours is worse than no shortcut at all.
- **`getting-around` does not invite a press.** The shortcuts stage lights a card when the
  real combo is pressed, which is what makes it trustworthy. No gesture on that stage can be
  performed against the surface covering the layout it acts on, so the rows report instead
  of inviting. A row that asks for a swipe and never responds is worse than a plain list.
- **The surface is lazily imported and never pre-warmed.** A client that has already been
  through it must not pay for the chunk.
- **Every stage has a way out.** Continue may dim, Skip never does, and the header's
  "Skip setup" finishes the flow from anywhere.
