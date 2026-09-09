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

- **Idle means the keyboard has been elsewhere for a grace.** The bar takes
  the keyboard on its own `focusin` and opens at once. It lets go only after
  a leave has settled: 150ms after the last focus change or pointer release
  anywhere in the document, the bar reads where focus actually is. In the bar
  or in a menu the bar opened — bits-ui floating content or a dialog — is not
  a leave. Elsewhere, or on nothing, is. A window blur is not idle: the bar
  keeps its shape so the app does not paint one collapsed frame on return.
- **Nothing predicts a return.** Most leaves are not leaves: a closing picker
  blurs its content a frame before it hands focus back, a sidebar row takes
  focus on mousedown and asks for the input back two frames after the click,
  and a settled recorder hands the keyboard back a frame after the mic lets
  go. Each used to carry a hold of its own — a "refocus pending" flag the
  caller set before its deferred focus — and every hold not released on time
  left the bar stuck open, or folded it on one frame and unfolded it on the
  next. The grace replaces all of them: a return inside it is simply not a
  leave, and no caller has to tell the bar it is coming.
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

The dock stays in flow. The transcript, the action row, and the activity
strip end where the bar begins, so all three take the room back the moment
the bar folds and no gap opens under the transcript while it rests. The
alternative, a dock floating over a transcript that keeps the expanded height
clear, was tried and rejected: it left a band of empty space between the last
message and the resting bar.

The motion is a FLIP over that flipped layout, run through the Web Animations
API (`input/lib/composer-fold.ts`). An earlier version tweened the row and the
well in CSS and let the card's height follow them in flow; that laid out the
whole conversation column on every frame and the transcript's resize observer
re-pinned the scroll on every one of them, so the fold read as laggy on a long
session however short the tween. Now, for the length of the tween, the card's
host holds its destination height while the card, lifted out of flow and
anchored to the host's bottom edge, tweens its height from where it was. The
prompt line slides from its old position to its new one, and on expand the
toolbar row arrives through the second half of the tween with a fade and a
short drift, once the card has grown room for it. The column and the
transcript move once per fold; the card catches up over the tween. The clock
is 280ms on `cubic-bezier(0.32, 0.72, 0, 1)`, a slower settle than the
chrome's base clock because the card travels further than a chip does.
Reduced motion turns the whole fold into a cut. A host opts in by marking the
card `data-composer-surface`; the Editor card and the Pill composer do.

Two more things hold the bar open: a press that began outside the bar and has
not been released, so a drag-select in the transcript never folds the bar
under the gesture, and so a click's consequences have the grace to land after
the release rather than the press; and a live selection inside the
transcript, which lets go when the selection does.

While the bar holds the keyboard it watches focus on the document, not on its
own box: a picker's content is portalled outside the bar, and a menu that
closes by letting go — a click on the transcript with no return target —
fires nothing on the bar. The watcher is attached only while the bar is open,
so a resting bar costs nothing. The grace, the hold, and the reads are in
`input/lib/composer-fold.svelte.ts`; the pure rules are in
`input/lib/composer-collapse.ts`, and `tests/unit/composer-fold-grace.test.ts`
drives the compiled controller through the sidebar click, the transcript
click, a menu letting go, a hidden window, a drag-select, and a dictation.
