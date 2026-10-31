<script lang="ts">
  import type { Snippet } from "svelte";
  import type { StatusCardState, TurnStartKind } from "@solus/contracts/types";
  import type { ToolHistoryStore } from "../../contexts/workspace/tool-history.store";
  import { getSettingsContext } from "../../contexts";
  import { type Turn, type GroupedItem, itemKey, needsLiveRow, shouldAnimateTurnEntry, visibleTurnBody } from "./lib/turns";
  import { describeBackgroundWait, settledBackgroundWait } from "./lib/activity-summary";
  import BackgroundWorkRow from "./BackgroundWorkRow.svelte";
  import TurnActivityRow from "./TurnActivityRow.svelte";
  import StatusCard from "./StatusCard.svelte";
  import TurnBody from "./TurnBody.svelte";
  import TurnEndDivider from "./TurnEndDivider.svelte";
  import ToolInputStatus from "./ToolInputStatus.svelte";
  import TurnImageGallery from "./TurnImageGallery.svelte";
  import ToolGroupItem from "./ToolGroupItem.svelte";
  import { measureMount } from "../../lib/mount-timing";
  measureMount("ConversationTurn");
  let { turn, index, total, expanded, isAwaitingInput, activityLabel, setupLabel, turnStart, attempt,
    hasBackgroundWork = false, onStopBackgroundWork = async () => {}, history, onToggle, onRetry, transcriptItem, serverId,
    settledSetupCard }: {
    turn: Turn; index: number; total: number; expanded: boolean; isAwaitingInput: boolean;
    activityLabel?: string;
    /** The setup step that runs now, while the session's setup card is active. */
    setupLabel?: string; turnStart: TurnStartKind | null; attempt: number;
    /** The session's turn ended, but a task it launched is still running. */
    hasBackgroundWork?: boolean; onStopBackgroundWork?: () => Promise<void>; history: ToolHistoryStore;
    onToggle: (expanded: boolean) => void; onRetry: () => void;
    transcriptItem: Snippet<[GroupedItem, boolean]>;
    /** The session's host, for naming who stopped a turn. */
    serverId?: string;
    /** The setup this turn's send ran, once it finished: drawn after the prompt. */
    settledSetupCard?: StatusCardState;
  } = $props();
  const settings = getSettingsContext();
  const body = $derived(visibleTurnBody(turn, settings.showToolCalls));
  const items = $derived([...body, ...turn.tail]);
</script>

{#if turn}
{@const skipMotion = !shouldAnimateTurnEntry(
  turn,
  index,
  total,
)}
{@const isLastTurn = index === total - 1}
{@const live = turn.live}
<!-- A steer leaves earlier turns live too, and only the last one is
   where the run is actually working. A turn parked on a question
   or permission stays live so nothing folds, but the card is what
   the run is doing — no spinner claims otherwise. -->
{@const working = live && isLastTurn && !isAwaitingInput}
<!-- A stop says nothing about the work, so it never stands in for
   the summary row: the row reports what ran and discloses it,
   and the stop's own divider follows the turn's content below.
   A failure keeps its row either way — it carries the error. -->
{@const hasSummaryRow =
  !live &&
  (body.length > 0 || turn.end?.kind === "failed")}
{#if turn.lead}
  {@render transcriptItem(turn.lead, skipMotion)}
{/if}
{#if settledSetupCard}
  <StatusCard card={settledSetupCard} {skipMotion} />
{/if}
<!-- The row only exists once the turn is over; until then the
   transcript below renders exactly as it always did.
   Retry re-runs the last prompt, so only the last turn can
   honestly offer it; an older stop is history. -->
{#if hasSummaryRow}
  <TurnActivityRow
    {turn}
    live={false}
    {expanded}
    attempt={isLastTurn ? (attempt) : 1}
    onToggle={() => onToggle(expanded)}
    onRetry={turn.end?.kind === "failed" && isLastTurn
      ? onRetry
      : undefined}
  />
{/if}
<!-- One keyed list for the whole turn: ending or folding it changes a
   class, never which block an item lives in. Svelte keeps an item mounted
   only within its own {#each}, so moving the answer to the tail or a render
   to the folded view would destroy and rebuild it — an artifact's iframe
   reloads and flashes blank. Folded work mounts on first expansion, then
   stays mounted so folding retains its local state. -->
{#if items.length > 0}
  <div class="space-y-2 @max-[30rem]/pane:space-y-3">
    {#if body.length > 0 && expanded && settings.showToolCalls}
      <div class="turn-item" class:is-open={!live}><ToolInputStatus tools={turn.tools} history={history} /></div>
    {/if}
    {#each items as item, itemIdx (itemKey(item))}
      {@const folds = itemIdx < body.length && !turn.visibleWhenCollapsed.includes(item)}
      <div class="turn-item" hidden={folds && !live && !expanded} class:is-open={itemIdx < body.length && !live && expanded}>
        {#if hasSummaryRow && itemIdx === body.length}<div class="turn-rule"></div>{/if}
        <TurnBody visible={!folds || live || expanded}>
          {#if item.kind === "tool-group"}
            <!-- §16 — the transcript keeps its order, but the row at
               the tail of a working turn is where the run *is*: it
               takes the spinner rather than letting a second row
               saying "Thinking" stack underneath it. -->
            <ToolGroupItem
              history={history}
              tools={item.messages}
              steps={item.steps}
              {skipMotion}
              working={working && itemIdx === body.length - 1}
              {activityLabel}
              turnStart={working ? turnStart : null}
              backgroundWait={working
                ? describeBackgroundWait(turn.body)
                : null}
            />
          {:else}
            {@render transcriptItem(item, skipMotion)}
          {/if}
        </TurnBody>
      </div>
    {/each}
  </div>
{/if}
<TurnImageGallery messages={turn.images} {serverId} />
<!-- §17's transient endings, in the place they happened: after
   everything the turn produced, never in front of it. -->
{#if !live && turn.end && turn.end.kind !== "failed"}
  <TurnEndDivider
    end={turn.end}
    onRetry={isLastTurn ? onRetry : undefined}
    {skipMotion}
    {serverId}
  />
{/if}
<!-- Background work is the session's state, not this turn's: the last
   turn states it, where the live row would be, even when an earlier turn
   launched the task. -->
{#if hasBackgroundWork && isLastTurn && !live}
  <BackgroundWorkRow wait={settledBackgroundWait(turn.body)} onStop={onStopBackgroundWork} />
{/if}
<!-- Only when nothing else is reporting the run: a tool group at
   the tail already carries the spinner. -->
{#if working && needsLiveRow(turn, settings.showToolCalls)}
  <TurnActivityRow
    {turn}
    live
    {activityLabel}
    {setupLabel}
    turnStart={turnStart}
    backgroundWait={describeBackgroundWait(turn.body)}
    expanded={false}
    attempt={attempt}
    onToggle={() => {}}
  />
{/if}
{/if}

<style>
  /* The open body's rail: each item draws its own edge, and an item followed
     by another open item bridges the gap between them. */
  .turn-item.is-open { position: relative; margin-left: 0.9375rem; padding-left: 0.75rem; border-left: 0.0625rem solid color-mix(in oklch, var(--foreground) 9%, transparent); }
  .turn-item.is-open:has(+ .turn-item.is-open)::after { content: ""; position: absolute; left: -0.0625rem; top: 100%; width: 0.0625rem; height: 0.5rem; background: color-mix(in oklch, var(--foreground) 9%, transparent); }
  @container pane (width < 30rem) {
    .turn-item.is-open:has(+ .turn-item.is-open)::after { height: 0.75rem; }
  }
  .turn-rule { height: 0.0625rem; margin: 0 0 0.75rem; background: color-mix(in oklch, var(--foreground) 8%, transparent); }
</style>
