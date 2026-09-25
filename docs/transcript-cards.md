# Transcript cards

Every raised object in the conversation transcript uses one shell,
`TranscriptCard` (`packages/workspace-ui/src/components/conversation/`). A card is
one 40px line at full column width. It uses the same slots as `ActivityRow`, so
cards and activity rows line up down the turn. A body appears only when there is
something to read.

Source: the "Conversation Cards Spec" design project (turns 2b, 3a, 3b, 4a, 4b).

## Principles

1. **One line first.** Every card is usable at its 40px header line.
2. **Same column as the text.** Full column width, with the left edge flush to the
   prose. No centring and no percentage widths.
3. **Same slots as `ActivityRow`.** A 22px glyph slot, a title, a target, and a
   rail. All sans: mono is kept for code, such as file paths in a diff tree and ids.
4. **Name the type once.** A lowercase type word after the title (`plan`, `doc`,
   `diagram`). No uppercase kicker and no status chip. The glyph and the type word
   carry state.
5. **Raise only what blocks.** Passive cards use the quiet shell. Only a card that
   stops the turn until the user acts uses the attention shell.

## Anatomy

```
| pad-l | glyph 22 | gap | Title | type word | target | flex | rail | actions | pad-r |
```

| Slot | Rule |
|---|---|
| Glyph | 13px icon in the 22px slot, muted. `is-done` (sage), `is-failed` (destructive), `is-artifact` (primary). `.activity-spinner` while running. |
| Title | `--text-activity-label`, 500. Truncates first. |
| Type word | Lowercase, muted, never truncates. A failure reason goes here. |
| Target | Optional path, branch, or file. Sans, `--text-tool-step`. |
| Rail | Counts and time only, never prose. Sans with tabular figures, `--text-transcript-meta`, 70%. |
| Actions | 24px targets (22px on a laptop display, 32px on touch). At most one primary and one ghost button, plus split and ⋯. |

Body layouts (`bodyLayout`):

- `prose` — indented by `--tx-card-body-indent` so text aligns with the title.
- `media` — full-bleed under a 0.5px rule, capped at 150px.
- `rows` — grouped rows (`TranscriptCardRow`) under a rule inset 12px.

A running sub-agent draws a 2px progress seam on the bottom edge (`seam` snippet).

## Actions

`TranscriptCardAction` renders every button on a card line and every row in its
⋯ menu. It stops the click so that the card does not open too.

- `primary` — 6% fill. Open, Report, Read, Done.
- `filled` — only when the card waits on the user. Review, Connect, Sign in.
- `ghost` — no fill. Pause, Annotate, Stop, Not now.
- `icon` — 24px square. Split and dismiss.
- `item` — a row in the ⋯ menu.

The split icon is always visible, never hover-only. Cmd-click on a card does the
same. The ⋯ menu holds publish, task link, copy id, provenance, stop, and change.
Cards with a visible body place actions in a wrapping footer at the bottom-right.
Header-only cards keep actions at the right edge. Disclosure controls stay in the
header. This applies to rate limits, setup recovery, connections, and output cards.

The host applies Queue to held user prompts when the setting changes or a client
rejoins. The decision card disappears only after the host confirms a queued retry.

## States

| State | Shell |
|---|---|
| Resting | quiet |
| Hover (clickable) | `--solus-tx-quiet-shadow-hover`, no translate |
| Pressed | `scale(0.996)` |
| Focus-visible | 2px `--solus-accent-border-medium`, offset 2px |
| Open in the pane | `open`: the composer's focus ring (1px accent at 34%, 4px halo at 9%); a grouped row takes the 1px ring inset |
| Running | spinner; type word becomes a participle; seam when steps are known |
| Streaming | same height as the landed card, skeleton bars and a word count |
| Failed | `failed`: destructive 26% ring; reason in the type slot; Retry |
| Waiting on the user (agent) | `waiting`: chart-2 40% inset ring; body opens |
| Blocking interrupt | `variant="attention"` |
| Resolved interrupt | quiet, header only, check glyph, Done |
| Closed or superseded | `superseded`: 0.85 opacity, 1 on hover |

Attention applies only to Connect, Seat, and RateLimit cards, through
`AttentionCard`. Permission and question cards keep their full raised layout in
`InterruptCard`, with an eyebrow, a meta line, and a footer. This is a product
decision: their controls need the room.

Sub-agent cards carry no status word: the glyph is the status (a spinner while
running, a check when returned, a warning when failed). Their rail leads with the
provider's mark and the model's name, then steps and time.

The agent conversation card is header-only. Its dialogue is read in the agent's
own session, which a click on the card opens. A body appears only when the other
agent waits on a person here (a request or a plan decision).

## Tokens

`workspace.css` declares `--solus-tx-quiet-*`, `--solus-tx-attention-shadow`,
`--solus-tx-divider`, and the `--tx-card-*` geometry. On a
fine-pointer laptop display the line is 36px, rows are 30px, and the radius is
10px. Touch keeps the 40px line. In dark mode the quiet shell drops its lift
because the fill does the lifting.

## Not in scope

- The agent conversation switchboard was deleted before this change, so its
  rows in the design are not built.
- A mixed "turn outputs" group for 3+ cards of different types is an open
  question in the design and is not built.
