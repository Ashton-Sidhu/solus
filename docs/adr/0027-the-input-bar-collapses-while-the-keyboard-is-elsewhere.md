# 0027. The input bar collapses while the keyboard is elsewhere

## Status

Accepted, 2026-09-05.

## Context

The composer card is the tallest fixed piece of chrome in a conversation: a
text well with generous padding and a toolbar row of pickers under it, about a
hundred pixels in Editor mode. It stands at that height whether or not anyone
is typing. While the user reads the transcript, scrolls a diff, or watches a
turn run, that space is spent on controls they are not using.

The pickers on the toolbar are portalled. The model chip, the permission
picker, and the saved-prompts sheet all move the keyboard into a floating
layer outside the card while they are open, and hand it back to their trigger
when they close. A collapse that keyed on the card's own focus alone would fire
the moment a menu opened, hide the trigger the menu is anchored to, and leave
focus with nowhere to return.

## Decision

An idle input bar collapses to one line. The rule and its exceptions:

- **Leaving the input starts collapse without a timed delay.** The bar takes
  the keyboard on its own `focusin` and opens at once. After an ordinary blur
  or pointer release, it reads focus in the next event-loop task, with no
  150ms grace. This lets the current click or focus event finish first.
  Focus in the bar or one of its floating menus still holds it open.
  A window blur also keeps the bar's shape.
- **Only a closing menu or recorder gets a refocus grace.** These can return
  focus on a later frame, so they retain a 150ms grace. Ordinary navigation
  does not wait for a possible future return: if it returns focus later,
  the current collapse reverses into expand. A return in the same event
  cancels collapse before it starts.
- **The collapse hides the toolbar row and tightens the text well. Nothing
  else.** Mic and send stay, inline beside the well, so the reverse-state
  guarantee holds: you can always send and always stop dictating. Attachment
  chips (screenshots, files, browser marks) and the "Working on" chip stay
  above the well, so what the next prompt carries is never hidden. Draft text
  stays in the well.
- **The mic holds the bar open for its whole cycle.** The waveform stands in
  for the text well and its cancel and confirm controls must not move under
  the hand. The wait for the microphone before it and the transcription after
  it hold the bar too. The mic letting go is decided like any other leave:
  the editor is handed the keyboard a frame later, inside the grace, so the
  bar never folds on its own after a dictation. Only if the keyboard was
  elsewhere for the whole recording and nothing hands it back does the bar
  fold once the grace is up.
- **A shortcut that opens a toolbar picker focuses the bar first,
  synchronously.** The run picker and the task picker anchor to chips on the
  toolbar row. Focusing the editor before the picker opens puts the row back on
  screen in the same flush the picker positions against.
- **Sending a prompt in a session returns focus to that input bar.** Enter
  and Send focus the same editor directly after clearing it, including on
  touch devices. This keeps the bar ready for the next prompt in Editor and
  Pill modes, on desktop, web, and mobile. The editor stays available while
  the session connects; sending another prompt waits until it is ready.
- **It is a setting, on by default, promoted to host config.** It is a personal
  preference like the turn diff summary, so it follows the user across
  devices. Turning it off returns the full card at rest.
- **The session draft pane does not collapse.** There the bar is the page:
  nothing sits behind it to give room to, and a draft with its pickers tucked
  away reads as a search box, not a place to start work. The bar takes a
  `collapseWhenIdle` prop for this, and the draft pane is its only `false`.
- **A phone does not collapse.** On a touch device with no keyboard pointer,
  the toolbar row holds the `+` menu, which is the only way to attach, capture,
  or change the run. Collapsing would cost a tap into the field and a
  soft-keyboard pop before each of those. The same predicate that suppresses
  auto-focus on a phone (`runtime.shouldSuppressFocus`) turns the collapse off.
  An iPad with a hardware keyboard collapses like a laptop.

## Consequences

Every host of the bar gets the behavior from the bar itself: the Editor dock,
the split conversation pane, Pill mode, and the web client. The session draft
pane opts out.
The editor, the toolbar, and the pickers are folded, never unmounted, so their
state survives.

The fold flips the layout in one step: the toolbar row folds through grid rows
1fr↔0fr and the text well's padding takes its other shape, with no CSS
transition on either. A folded row is `inert` and `invisible`, so it is out of
the Tab order and off screen without being unmounted. Mic and send are pinned
to the card's bottom-right corner in both states, so nothing moves between two
rows.

The dock floats over the conversation and the column reserves the band it
needs in `--solus-composer-inset`. This replaces the original in-flow dock,
which resized the transcript on every fold: the scroll viewport grew by the
fold distance, the browser clamped `scrollTop` to the smaller maximum, and
the whole conversation slid under the reader. That happened on a reduced-motion
cut as much as on the animation, so it was never something the tween could fix.

The reservation is *held* while the bar rests. A folded measurement may only
hold the band, never shrink it; an expanded measurement is authoritative and
may shrink it, which is how a departing chip or draft line gives the room back.
So unfolding does not move the transcript either — both directions are inert.
The transcript's bottom padding and the minimap's centre take that held band.
The rule is `resolveComposerInset` in `input/lib/composer-collapse.ts`; the
card publishes its state for the dock to read as `data-composer-collapsed`.

The action row — the orb and the activity strip beside it — is the exception,
and takes a second var, `--solus-composer-height`: the bar's live top edge. It
belongs to the bar rather than to the transcript, so it hugs the bar and
travels with a fold. Anchored to the held band instead, it stranded itself at
the top of the band with dead space underneath while the bar rested. It travels
on the fold's own duration and easing, published from the same constants, since
the card's WAAPI tween reports the dock at its destination height from the
first frame and the row would otherwise jump the whole distance at once. The
travel is armed only after the bar's first measurement, so opening a
conversation does not slide the row up from nothing.

The cost is a band of background between the last message and the resting bar,
which the first version of this decision rejected. It is paid back by the
float: the rows scroll *under* the bar and dissolve into it, so the collapse
still gives reading space to everything except the very end of the transcript.
An opaque dock in flow would have kept the band and reclaimed nothing.

That dissolve is the transcript's own bottom edge (`.transcript-fade` in
`ConversationView`), riding the bar's live edge beneath the action row. Painted
from the dock instead, it also washed out the lower half of the row sitting on
that edge.

A bar that has never been expanded reserves its folded height, and the first
expansion moves the transcript once. Guessing an expansion delta instead would
be a number no surface agrees on.

Pill mode is unchanged. Its composer is a separate card below a body of fixed
height, and the whole stack is bottom-anchored, so the body descends with the
folding bar as the card's own geometry rather than through a transcript
re-pin. A phone does not collapse at all, so the mobile clients never see
either shape.

Collapse and expand use the same 280ms animation on
`cubic-bezier(0.32, 0.72, 0, 1)` through the Web Animations API
(`input/lib/composer-fold.ts`). The host holds its destination height while the
card is lifted out of flow and anchored to its bottom edge. The prompt slides
from its previous position. On expand, the toolbar fades in with a short drift
through the second half of the animation.

On collapse, the mic and send buttons are compensated for the inner content's
immediate size change so they do not jump up and then slide back down. The
toolbar stays outside layout at its previous height and fades out through the
first half of the animation. It becomes inert immediately. Temporary styles are
removed on completion or interruption. Reduced motion makes both directions
immediate. The Editor and Pill cards opt in with `data-composer-surface`.

Two more things hold the bar open: a press that began outside the bar and has
not been released, so a drag-select in the transcript never folds the bar
under the gesture, and so a click can finish before focus is read; and a live selection inside the
transcript, which lets go when the selection does.

While the bar holds the keyboard it watches focus on the document, not on its
own box: a picker's content is portalled outside the bar, and a menu that
closes by letting go — a click on the transcript with no return target —
fires nothing on the bar. The watcher is attached only while the bar is open,
so a resting bar costs nothing. The refocus grace, holds, and focus reads are in
`input/lib/composer-fold.svelte.ts`; the pure rules are in
`input/lib/composer-collapse.ts`, and `tests/unit/composer-fold-grace.test.ts`
drives the compiled controller through the sidebar click, the transcript
click, a menu letting go, a hidden window, a drag-select, and a dictation.
