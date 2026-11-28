# Opening a session while a turn runs

A client that opens a session whose turn still runs gets that turn from two
sources: the durable history page and the watch's replay of the turn log.
Before this plan no rule said how the two overlap. The result was different on
each provider: Claude Code and Codex write the running turn to their own
history as it goes, so a client showed it twice (a second prompt bubble, then
duplicated tool cards); Antigravity (ACP) writes a turn only when it ends, and
the turn log did not keep the prompt, so a client showed the tool calls with no
prompt until the turn ended.

## The rule

**History holds settled turns. The running turn comes only from the turn log.**

## Vocabulary

- **running turn** — the turn of a session that a run holds now (its provider
  turn, its request, or its setup), from its prompt on.
- **turn log** — `SessionRuntime.turnLog`: every event of the running turn that
  went to the session's watchers, from its prompt on, in order. A new turn
  starts a new log (host rule 1); the log is cleared when the provider query
  exits.
- **prompt** — the `user_message` that starts a turn. A steer
  (`delivery: 'steer'`) joins the running turn. A prompt into a query that
  background work keeps open, after its turn settled, joins no turn: it is a
  prompt, not a steer.
- **`runningTurnStartedAt`** — the time the host recorded the running turn's
  prompt. It names the turn: a watch result names the turn it replayed, and a
  history page names the turn it left out.
- **opening read** — `loadSessionPage` with `openSession`: one answer with the
  description, the watch, and the page.

## The host

1. **The turn log holds the whole turn, and no turn before it.** It starts
   again where a turn starts: when a run's turn begins, before its setup
   (`startRunLifecycleInScope`), and when a prompt goes into a query that
   background work keeps open after its turn settled (`steerActiveTurn`). Such
   a prompt's echo has no `delivery: 'steer'`. A turn that the agent starts on
   its own in that open query (a background task woke it) has no prompt; it
   stays in the log of the prompt before it, as the history cut below expects.
   Without this, every later prompt joined the first one's turn: the page left
   out all of them and the replay was only the newest 2000 events. A publish is recorded unless it goes
   to one client only (`only`: a replay or a private echo). The prompt echo that
   skips its sender (`except`) is recorded too. Because the sender already shows
   its own copy, such a publish still starts a new cursor epoch, so a resume
   after it reads a fresh snapshot. When the log drops its oldest events
   (`TURN_LOG_MAX_EVENTS`), it keeps the prompt and starts a new epoch.
2. **A history read leaves the running turn out.** The newest page cuts the
   trailing turns whose turn-starting rows are dated from the second the prompt
   was recorded (`settledHistory` in `session-history.ts`). Codex dates every
   row of a turn by the turn's start in whole seconds, hence the second. A row
   dated after the read began has no date of its own and is not cut. An ACP page
   has nothing to cut. The cut replaces the earlier `startingPrompt` row: the
   turn log holds the prompt from the moment it is published, before the run is
   in `activeRunRequests`.
3. **A watch replays the running turn.** `attachRuntime` replays the whole log.
   A run that is still starting (setup or launch, before the provider session
   exists) replays the latest setup card and the turn from its prompt on. The
   result names the replayed turn in `runningTurnStartedAt`. The replay goes
   through the client's event queue, behind the audience check of its first
   event. The watch answers only after that queue sent it
   (`ClientEventRegistry.delivered`), so the replay always reaches the client
   before the answer. Without this, the answer could arrive first, and a client
   applied the whole turn as live events: the phone streamed the turn again
   from its prompt.
4. **An opening read is one moment.** The host starts the watch first, then
   reads the page and leaves out the turn that the watch replayed (or a turn
   that started after the watch, whose events reached the client live). The
   answer carries the page, `resumedWatch`, and `runningTurnStartedAt`.

## The clients

- **Mobile** opens with the opening read, on the first open and on every reload
  after a reset. Events that arrive before the page are held and applied after
  it. There is no overlap to reconcile, so `reconcileWatchReplay` is gone.
- **Desktop and web paint once.** A page that leaves out a running turn
  (`runningTurnStartedAt` on the page) waits for the watch, and the replay is
  applied in the same step that puts the page on screen, before the loading
  state clears. The conversation then opens at its end with the running turn,
  and does not slide down while the replay lands under the reader. A page with
  no running turn paints at once. A restored tab (`hydrateTab`, also a window
  reload) starts its watch beside the page, once the description answers.
- **Desktop and web** keep their page read beside a separate watch, because the
  page can come from a prefetch made on hover or press. The reducer holds the
  session's events from the watch until the page is on screen
  (`holdEvents` / `releaseEvents`). The page and the watch fit when they name
  the same `runningTurnStartedAt`. When a turn started or ended between the two
  reads they do not, and the client reads again with one opening read
  (`fitTranscriptToWatch`). A restored tab follows the same check.
- **Resume.** Desktop keeps the cursor of the last turn event applied to each
  session and resumes after it when the transport resets. A host that cannot
  resume replays the turn from its prompt; the reducer's tool-id matching keeps
  one card per call for that case.

## Not covered

- In Solus API mode `watchSession` does not replay, and the mirror's history
  page is not cut. A reader of the cloud copy sees the turn as the mirror has it.
- `loadSession` (the whole transcript), `read_session`, session search, and
  the transcript mirror read the provider's history as it is, running turn
  included.
- A response fork's page (`forkHistory`) is not cut.
- A turn that starts and settles completely between two reads of an opening (a
  few milliseconds) can still be lost or shown twice.
- Two turns that start in the same wall-clock second: the earlier one is left
  out of the page while the later one runs.
- A turn log of more than `TURN_LOG_MAX_EVENTS` (2000) events keeps its prompt
  and its newest events. The page still leaves the whole turn out, so the
  reader sees the prompt, a gap, and the turn's tail until the turn ends. A
  prompt whose query wakes many times on its own (background tasks) reaches
  this limit soonest.
