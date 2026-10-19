# Lane report: composer-and-sheets (19 October 2026, revised after parent review)

Scope: #20812 compact-until-wrap composer, #21319 close/apply sheet affordances, #20802 Android menu icon taps, #20803 Android keyboard after an app switch. Mobile only (iOS and Android). Desktop and web keep their own composer and sheet patterns; no Svelte change. The composer does not depend on the provider: Claude and Codex behave the same. No server, RPC, or local/remote change.

## Changed files

| File | Change |
| --- | --- |
| `apps/mobile/src/features/threads/composer-layout.ts` (new) | Pure rules: `composerUsesCard`, `measuredDraftText`, `oneRowVerdict`, `oneRowMeasureFrame`, `oneRowEditorHeight`, `ONE_ROW_MEASURE_LIMIT`, `ONE_ROW_MIN_EDITOR_SHARE`. |
| `apps/mobile/src/components/ComposerEditor.tsx` | New exported `ComposerTextMeasure`: a hidden copy of the text in the editor's own font (`editorFont`, shared with the editor), inside a frame the caller positions. Its `onLines` gives each layout's lines. |
| `apps/mobile/src/features/threads/ThreadComposer.tsx` | Compact until wrap. The model control is in the row while editing. `onExpandedChange` now reports the card, not focus. |
| `apps/mobile/src/features/threads/android-keyboard-resume.ts` (new) | `KeyboardResumeGuard`, owned by events only. |
| `apps/mobile/src/features/threads/ThreadDetailScreen.tsx` | On resume, quarantine only if the composer does not own the keyboard or a hide was in progress. |
| `apps/mobile/src/components/MaterialMenuPopup.android.tsx` | Hosted icons are an inert `Pressable` that runs the row action (#20802 port). |
| `apps/mobile/src/components/AppSheet.tsx` | iOS Done text → `xmark` icon. The `Close <title>` label and the `onClose` callback are kept. |
| `apps/mobile/src/features/threads/ThreadSettingsSheet.tsx` | iOS Cancel → X. The prominent checkmark shows only while a model is staged. Android keeps Back and the Save text. |
| `tests/unit/native-mobile-composer-and-sheets.test.ts` (new) | 27 focused tests. |
| `plans/t3-performance-review-2026-10-19/tsconfig.composer-and-sheets.json` (new) | Narrow typecheck config (see Verification). |

## Corrections in this round (parent review items 1–6)

1. **No render-time ref writes added.** `measuresRowRef` was removed. Row measurement now runs on committed `onLayout` props: the editor's handler is attached only while the card is not shown, and the trailing group's only while editing. The keyboard owner is `KeyboardResumeGuard`, held in `useRef(new …)` and changed only from:
   - composer focus and blur events (`handleComposerFocusChange`);
   - the thread-change layout effect (`composerFocusChanged(false)`);
   - a `useLayoutEffect` on the committed question id (`questionShownChanged`);
   - `KeyboardEvents` and `AppState` listeners.

   A question still takes ownership, and an answer gives it back. The only `.current =` lines in my diff are the existing `settingsPresentedRef` writes inside callbacks.
2. **Row geometry has no pairing.** The old owner paired a surface width from one layout event with an editor width from another. It is replaced:
   - JavaScript stores only the widths beside the editor. The leading width is the editor's `layout.x`. The trailing width is the trailing group's `layout.width`, keyed by the model label it was measured with. Each comes from its own element's event, so event order cannot mix layouts.
   - `oneRowMeasureFrame` makes the hidden copy an absolute view with `left`, `right` and `minWidth: "40%"` in the composer's full-width container. Yoga resolves its text width from the current composer width in the same pass that lays out the text.
   - A model control measured while shrunk can overestimate the width after a widen. Then the row shows once, its new layout gives the natural width, and the result holds. This is at most one correction, never a lock-in.
   - A new model label makes the trailing width unknown. Unknown chrome means the row shows (`rowMeasured: false`), so a card can never be held by stale chrome.
3. **Stale text layouts are ignored, by mechanism.** Each line in `onTextLayout` carries its exact substring (Android `FontMetricsUtil.kt:67` `text.subSequence(getLineStart, getLineEnd)`; iOS `RCTTextLayoutManager.mm:392` `substringWithRange` per line fragment). So `oneRowVerdict` accepts a layout only if its lines join to the current measured draft. The handler is the committed render's closure (Fabric calls the current props' handler), so a queued layout of an earlier draft returns `null` and is dropped.
   - **Width.** Width is not keyed in JavaScript; it is resolved by Yoga. An old-width layout of the same text cannot arrive after a newer one: `textLayout` is a non-unique event, `EventQueue::enqueueEvent` appends it FIFO (`ReactCommon/react/renderer/core/EventQueue.cpp:25–55`), and `ParagraphEventEmitter::onTextLayout` (`ParagraphEventEmitter.cpp:38–50`) dispatches in layout order. It sends nothing only when the lines are identical, and identical lines give the same verdict.
4. **NewTaskRouteScreen.** The earlier report was wrong. Its composer is a fixed card in every state (`ComposerSurface` `minHeight: 140` at `NewTaskRouteScreen.tsx:774`, editor `minHeight: 72` at `:657`). `isPromptFocused` only gates the hardware Return command (`:638`). It is a distinct new-task form, not the thread input's focus-triggered expansion, so it is unchanged. Compact-until-wrap applies to the thread composer: there, focus alone used to grow the card (#20812's finding).
5. **Tests are now behavioral where possible.** Source-spelling checks for ComposerEditor, ThreadComposer and ThreadDetailScreen are removed. Added:
   - A layout-pass protocol model. Each commit's events are delivered later against the committed state, FIFO or reversed. It covers narrowing and widening across the wrap boundary (at most one change per resize, ending on the truth), a model control measured while shrunk (at most two changes, then stable), and a new label while the card shows (re-measured, not locked).
   - Stale-layout ordering: a late wrapped layout after a delete; wrap, then send; in-order application.
   - Keyboard-guard event sequences: focus kept through a switch; send then Home; Back then Home during the hide; a finished hide; the keyboard shown again; a question takes and returns ownership; a thread change.
   - Mutation check, run and reverted: removing the text keying fails 2 tests, and removing the `rowMeasured` fallback fails 3.
   - Source checks remain only for the native menu and sheet presentations, which have no logic that bun can run: callbacks and accessible names kept.
   - The model proves the event protocol, **not** device text-layout parity, and the hidden `Text` is not proof that it breaks lines exactly as the `TextInput` does.
6. The exact typecheck and attribution lines are below.

## Composer behavior kept

- Any line break means the card, because iOS does not count a trailing newline as a line fragment. A cleared draft returns to the row at once. Removable attachments or queued-edit files use the card, which holds their strip. Only the first 1000 characters are laid out; a longer draft is the card.
- IME and caret: the editor stays at the same position in the tree, so it never remounts. Text attributes (iOS line height) follow *editing*, not the card, so a wrap during composition changes only layout props (height, padding, Android gravity). `scrollEnabled` also follows editing.
- Paste, attachments, the queued edit, hardware Return, `focusInput`, settings refocus and quote-in-reply keep their paths. At large text sizes, the row grows to one full line.
- No sidebar or rail suppression. Navigation lane: no callback is needed. `onEditorFocusChange` already exists if a later layout change needs it.

## Sheets and Android (unchanged this round)

- AppSheet (iOS): the X keeps the label `Close <title>`, and its `onClose` dismiss path is unchanged, so auth and integration cancellation stay intact.
- Session settings (iOS): the X label is "Close session settings", or "Close without saving the model" while a model is staged. It never says Cancel, because reasoning, fast mode and permission changes to the current model apply at once. The checkmark ("Save session settings", prominent) shows only while `pendingModel` exists. Android keeps Back and the Save text.
- Menu audit: `@expo/ui` `RNHostView` claims touches. Popup items are wrapped in `PresentedContent`, so `layoutRoot` is true and the host sends JS touches itself; inline menus use the surface root. The `Pressable` is `accessible={false}` and `focusable={false}`, and is disabled with its row.

## Verification actually run

- `bun test tests/unit/native-mobile-composer-and-sheets.test.ts`: 27 pass, 0 fail.
- At this revision `native-mobile-t3-parity.test.ts` gave 7 pass, 0 fail, and `native-mobile-thread-composer.test.ts` 21 pass, 0 fail. The earlier unrelated failures no longer reproduce; I did not change those areas. Log: `composer-and-sheets-round2-tests.log`.
- Narrow typecheck, reproducible: from `apps/mobile`, run `../../node_modules/.bin/tsc -p ../../plans/t3-performance-review-2026-10-19/tsconfig.composer-and-sheets.json`. Result: exit 0, 0 errors.
  - The config extends `apps/mobile/tsconfig.json` with `skipLibCheck: true`.
  - It includes `uniwind-types.d.ts`, `src/components/AppSymbol.tabler.d.ts`, and the 8 changed source files (ThreadComposer, ThreadDetailScreen, ThreadSettingsSheet, composer-layout, android-keyboard-resume, ComposerEditor, AppSheet, MaterialMenuPopup.android). Their import graph is checked transitively.
  - This is not a full mobile typecheck. It ran while no mobile `tsc` was running.

## Unrun device gates (required before release)

Physical iOS and Android; none of these were run:
- **Composer:**
  - one word stays a row; wrap → card; delete back → row with no oscillation;
  - explicit and trailing newline; paste of text and images; Japanese/Chinese IME composition across the wrap point; emoji/RTL;
  - largest font; pane narrowing and widening (iPad split, Android split);
  - attachments and queued edit; hardware Return and Cmd-L; settings round trip with a model-label change while the card shows; quote-in-reply.
- **Text vs TextInput line-breaking parity:** check at the edge. The 2-point caret slack is an estimate. Also check that Yoga resolves the absolute frame (`left`/`right`/`minWidth: 40%`) as modelled, and the iOS vertical centering of the editing row.
- **Sheets:** VoiceOver names, swipe and X dismiss, staged-model apply and discard, immediate option changes kept after X, auth sheet cancellation, light/dark contrast of the checkmark.
- **Android menu:** an icon tap fires once (leading, chevron, checkmark, back); disabled rows are inert; TalkBack has one target.
- **Android keyboard:**
  - focused → app switch → return; send → Home → return; Back → Home during the hide;
  - a question shown while focused, then answered;
  - whether `keyboardWillHide` always arrives before a Home pressed during the hide.

## Cross-lane needs and notes

- Coordinator: suggested `apps/mobile/UPSTREAM.md` attribution, for the threads row's "Local changes" or a new dated table (not edited by me):
  - `src/features/threads/ThreadComposer.tsx`, `composer-layout.ts`, `src/components/ComposerEditor.tsx` | T3 Code #20812 (`ThreadComposer.tsx`, `T3ComposerEditor*` content size) | Compact until the draft wraps. The width comes from a hidden copy laid out with React Native `onTextLayout` at a Yoga-resolved row frame, not T3's native editor content-size event. Removable attachments use the card. No sidebar hiding.
  - `src/components/AppSheet.tsx`, `src/features/threads/ThreadSettingsSheet.tsx` | T3 Code #21319 (`Sheet.tsx`, `ThreadSettingsSheet.tsx`) | X and checkmark on iOS. The checkmark shows only while a model is staged; the X never says Cancel. Android keeps Back and Save. Other T3 sites have no Solus counterpart.
  - `src/components/MaterialMenuPopup.android.tsx` | T3 Code #20802 (`MenuPopup.android.tsx`) | Same port.
  - `src/features/threads/ThreadDetailScreen.tsx`, `android-keyboard-resume.ts` | T3 Code #20803 (`ThreadDetailScreen.tsx`, `QuestionAttachments.tsx`) | Focus ownership plus a started-hide check, so Back then Home during the hide stays quarantined. A question that hides the composer takes ownership.
- Compiler lane: no new render-time ref writes. `KeyboardResumeGuard` is a mutable instance in a ref, changed only in handlers and effects. `ThreadComposer.tsx` is 763 lines and `ThreadDetailScreen.tsx` 627 (both over 600, flagged; they were 685 and 606 before this lane).
- No dependency, config or lockfile change is needed.

## T3 #20785: the Agents pill counts still-running agents from earlier turns

Authorized correctness item, mobile only.

**Problem.** `latestTurnAgentIds` stopped at the newest user row. After a new prompt, the pill and the Agents sheet lost an agent from an earlier turn that was still running or waiting.

**Live rule, from current presentation and state.**
- An agent card is live while its exchange tone is working or waiting (`agent-card-presentation.ts`: dispatched, queued, running, answered, waiting_for_children, awaiting_input, rate_limited).
- A provider subagent tool is live while its `status` is `'running'`.
- Stop settles running subagents (`settleInterruptedSubagents`), and an exchange the host no longer carries reads as `lost` (stopped), not live.

**Roster.** The roster is the newest turn's agents, settled ones included as before, plus earlier agents whose presentation is live. Rows stay in transcript order.

**Duplicates.** Mobile keeps one card per session per turn (`agent-cards.ts`), so one child session can have cards in several turns. As the desktop rail does (`rail-agents.ts`: "the last one says where it stands now"), a session lists once, by its newest card. Provider subagents are one row each, by tool item id. Ids are unique.

**Changed files.**

| File | Change |
| --- | --- |
| `apps/mobile/src/features/threads/agent-roster.ts` (new) | `agentCandidates(store, order)`: one pass over the order, giving agent ids, the newest-turn set, and the session of each card. `agentRoster(rows, candidates)`: the rule above. |
| `apps/mobile/src/features/threads/ThreadAgents.tsx` | `latestTurnAgentIds` replaced by `useAgentRoster(store)` (order → memoized candidates → `useAgentPresentations` over all candidates → memoized roster). The sheet uses it. The feed's `ThreadAgentGroup` is unchanged. |
| `apps/mobile/src/features/threads/ThreadDetailScreen.tsx` | The pill uses `useAgentRoster`; `useMemo` and `useListened` imports, now unused, are removed. |
| `tests/unit/native-mobile-agent-roster.test.ts` (new) | 8 tests on the real `TranscriptModel` with real events. |
| `plans/t3-performance-review-2026-10-19/tsconfig.agent-roster-20785.json` (new) | Narrow typecheck config. |

**Update path and cost.**
- Every candidate's item is subscribed through `useTranscriptItems`. An earlier agent that settles, waits or fails re-renders the pill and sheet with no order change; the test proves membership changes with the same candidates and an unchanged order.
- The candidate scan walks the loaded order once, and only when the order changes (a row is added or removed). A streamed token changes one item and causes no scan.
- Presentations are recomputed for all loaded agent items when one of them changes. That is a few dozen rows at most, not the transcript.
- `useAgentPresentations` may now load the child sessions once for a conversation whose agents are only in earlier turns.

**Desktop and web.** No gap. The rail Agents card (`project-panel/lib/rail-agents.ts`, `AgentsSection.svelte`) already lists every agent of the session across turns, active first, one row per session. No Svelte change.

**Not applicable.** T3 also excludes agents of rolled-back runs. Solus mobile has no rolled-back turn state in the transcript model or contracts, and a removed row leaves the order, so it leaves the candidates too.

**Verification actually run.**
- `bun test tests/unit/native-mobile-agent-roster.test.ts`: 8 pass, 0 fail. The tests cover:
  - earlier live session card and subagent kept after a new prompt, with the pill "2/3" while idle;
  - settle and fail without an order change;
  - rate-limited stays listed, failed leaves;
  - newest-turn completed agents kept;
  - earlier settled agents excluded;
  - a session in two turns gives one row with its newest card and unique ids;
  - no prompt row;
  - candidate uniqueness and the newest-turn mark.
- Mutation check, run and reverted: the old newest-turn-only rule fails 2 tests, and removing the session collapse fails 1.
- Adjacent suites: `native-mobile-agents` 20/0, `native-mobile-thread-feed` 12/0, `native-mobile-composer-and-sheets` 27/0.
- Narrow typecheck: from `apps/mobile`, run `../../node_modules/.bin/tsc -p ../../plans/t3-performance-review-2026-10-19/tsconfig.agent-roster-20785.json`. Result: exit 0, 0 errors. It checks `agent-roster.ts`, `ThreadAgents.tsx` and `ThreadDetailScreen.tsx` with their import graph, and is not a full typecheck; the compiler worker owns the integrated one.
- The compiler session (decb1bf3) was told about the changed files.

**Limitations.**
- Only the loaded transcript is read. An agent still running from a turn on a history page not yet loaded is not in the pill. T3 reads server run state; Solus mobile has no per-session list of live child exchanges in this path.
- A subagent tool row that history reports as `running` after an abnormal end stays live. Desktop's rail reads it the same way.
- The hook wiring (`useSyncExternalStore` subscriptions) is not exercised by a React renderer test. The pure rule and the candidate set it subscribes to are tested.
- Not run on a device: the pill count and sheet with an earlier running Solus child and a Claude/Codex subagent across a new prompt, and opening an earlier agent from the sheet.

**Suggested `apps/mobile/UPSTREAM.md` line** (coordinator):
- `src/features/threads/ThreadAgents.tsx`, `agent-roster.ts` | T3 Code #20785 (`client-runtime/src/state/threadSubagents.ts`) | The Agents pill and sheet list the newest turn's agents and earlier ones still working or waiting, read from the loaded transcript. A session messaged across turns is one row (its newest card), as the desktop rail. No rolled-back runs in Solus.

`ThreadAgents.tsx` is now 361 lines, and `ThreadDetailScreen.tsx` 630 (flagged as before).
