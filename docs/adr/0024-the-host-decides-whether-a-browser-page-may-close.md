# 0024. The host decides whether a browser page may close

## Status

Accepted, 2026-09-04.

## Context

A browser page's state lives on the server, not in whichever client is looking.
That is what lets an agent keep driving a page after the user closes the pane —
and it is also what makes closing a page dangerous in a way closing a pane is
not. A user tidying up chips in the page strip can end a `browser_wait_for` that
is halfway through a login flow on another machine, with nothing on screen to
say so.

The obvious fix — have the pane check the page before closing it — does not
work. A client's copy of a page is at least one event old, so a verb that started
in that gap would be interrupted by a close the user had just been told was safe.

## Decision

`browserClose` answers `BrowserCloseResult`, and the guard is evaluated on the
host at the moment of the close.

- A refusal is `{ closed: false, reason: 'agent-use', agentUse }` and carries a
  *copy* of the state that caused it, because the client holds it across a round
  trip and a user reading a dialog. The client turns that into a question; the
  answer comes back as `force`.
- **Active use is not "an agent opened this."** That fact never expires, and a
  page marked on it would be permanently unclosable without a prompt — by the
  third warning a user is dismissing it without reading. Use is a verb in flight,
  or the host's grace window after the last one finished. The
  window exists because a turn is a sequence of verbs with model round trips
  between them, and `running` is zero for most of that wall clock.
- **Every verb takes its hold in a bracket and releases it in a `finally`.** A
  verb that threw, timed out, or was abandoned mid-turn must not leave a page
  marked busy for the rest of the session. Releasing twice releases one hold, and
  releasing against a page that was force-closed underneath does nothing.
- **The expiry is announced, not merely computed.** A timer publishes the page
  once the grace window lapses, so a pane does not keep warning about an agent
  that finished minutes ago until some unrelated change happens to republish it.
- **`browser_close` forces for the session's own pages, and refuses for
  another's.** An agent tidying up a page it opened is the one thing an agent
  does to a page that is not use of it, and asking a user to confirm an agent's
  own cleanup would be a prompt about nothing. A page another session is in the
  middle of driving is that session's work, and the tool answers with a refusal
  rather than ending it.
- `browser_open` marks the page as used without holding it: a page created two
  seconds ago is one a user should be asked about, and it decays like any other
  use.
- **Clients read presence, not time.** The grace window and the clock that
  judges it are the host's alone. A client that recomputed "in use" from the
  host's timestamp and its own clock would disagree with the host by exactly the
  skew between the two machines, so the chip draws its badge from whether
  `agentUse` is present and nothing else. That is also why the page is published
  only when use begins and when it lapses: a broadcast at every verb boundary
  would be two events to every client per click for nothing a client renders.

## Consequences

Clients must treat a close as a request rather than a fact. The renderer store
forgets a page only when the host says it is gone.
