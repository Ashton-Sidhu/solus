# First-run onboarding

The one pass a fresh client makes before the workspace opens. Adapted from the
`Onboarding.dc.html` design in the Solus Claude Design project.

## Vocabulary — lock this before changing anything

| Term | Means |
|---|---|
| **first-run onboarding** | This flow. Client-scoped, once per install. |
| **host onboarding** | The *other* thing: `HostOnboarding.svelte`, the rail a **host** arrives through. Unrelated, and not a synonym. |
| **stage** | One screen of the flow: `intro`, `agents`, `providers`, `shortcuts`, `start`. |
| **asking stage** | Everything but `intro` — the four the user can move between. |
| **mode** | `project` or `chat`. What the `start` stage decided, and the only thing the flow hands to the workspace. |

Do not coin "step", "screen", "page" or "wizard" for a stage, and do not use "setup"
unqualified: `HostSetupSession` already owns that word for installs on a host.

## Shape

```
intro ──▶ agents ──▶ providers ──▶ shortcuts ──▶ start ──┬─ project ──▶ new-tab home + folder picker
                                                          └─ chat ────▶ new-tab home
```

Every asking stage is the same shape — a centred title, a column of washed rows, and a
quiet Continue/Skip pair. There is no rail, no footer, no step numbering and no summary:
the flow is short enough to hold in the head, and each stage already reports its own state.

`start` is last because it is the only stage that decides where the user lands. Answering
it *is* the finish: nothing may be inserted after it.

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
- **Enter answers only `shortcuts` and `start`.** The agents and providers stages dim
  Continue until something is connected; a keystroke that walks past a gate the button
  honours is worse than no shortcut at all.
- **The surface is lazily imported and never pre-warmed.** A client that has already been
  through it must not pay for the chunk.
- **Every stage has a way out.** Continue may dim, Skip never does, and the header's
  "Skip setup" finishes the flow from anywhere.
