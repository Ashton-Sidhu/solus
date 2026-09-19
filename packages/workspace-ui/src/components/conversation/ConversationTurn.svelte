<script lang="ts">
  import type { Snippet } from "svelte";
  import type { TurnStartKind } from "@solus/contracts/types";
  import type { ToolHistoryStore } from "../../contexts/workspace/tool-history.store";
  import { type Turn, type GroupedItem, itemKey, needsLiveRow, shouldAnimateTurnEntry } from "./lib/turns";
  import { agentsAwaitingReply } from "./agent-conversation/lib/agent-conversation";
  import { describeBackgroundWait } from "./lib/activity-summary";
  import TurnActivityRow from "./TurnActivityRow.svelte";
  import TurnBody from "./TurnBody.svelte";
  import TurnEndDivider from "./TurnEndDivider.svelte";
  import ToolInputStatus from "./ToolInputStatus.svelte";
  import ToolGroupItem from "./ToolGroupItem.svelte";
  let { turn, index, total, expanded, isAwaitingInput, activityLabel, turnStart, attempt,
    history, onToggle, onRetry, transcriptItem }: {
    turn: Turn; index: number; total: number; expanded: boolean; isAwaitingInput: boolean;
    activityLabel?: string; turnStart: TurnStartKind | null; attempt: number; history: ToolHistoryStore;
    onToggle: (expanded: boolean) => void; onRetry: () => void;
    transcriptItem: Snippet<[GroupedItem, boolean]>;
  } = $props();
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
  (turn.body.length > 0 || turn.end?.kind === "failed")}
{#if turn.lead}
  {@render transcriptItem(turn.lead, skipMotion)}
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
<!-- Folded history mounts on first expansion. Once shown, the
   body stays mounted so folding retains its local state. -->
{#if turn.body.length > 0}
  <div
    class="turn-body space-y-2 @max-[30rem]/pane:space-y-3"
    class:is-folded={!live && !expanded}
    class:is-open={!live && expanded}
  >
    <TurnBody visible={live || expanded}>
      {#if expanded}<ToolInputStatus tools={turn.tools} history={history} />{/if}
      {#each turn.body as item, itemIdx (itemKey(item))}
        {#if item.kind === "tool-group"}
          <!-- §16 — the transcript keeps its order, but the row at
             the tail of a working turn is where the run *is*: it
             takes the spinner rather than letting a second row
             saying "Thinking" stack underneath it. -->
          <ToolGroupItem
            history={history}
            tools={item.messages}
            {skipMotion}
            working={working && itemIdx === turn.body.length - 1}
            {activityLabel}
            turnStart={working ? turnStart : null}
            waitingOn={working
              ? agentsAwaitingReply(turn.body)
              : []}
            backgroundWait={working
              ? describeBackgroundWait(turn.body)
              : null}
          />
        {:else}
          {@render transcriptItem(item, skipMotion)}
        {/if}
      {/each}
    </TurnBody>
  </div>
{/if}
{#if !live && !expanded && turn.visibleWhenCollapsed.length > 0}
  <div
    class="space-y-2 @max-[30rem]/pane:space-y-3"
  >
    {#each turn.visibleWhenCollapsed as item (itemKey(item))}
      {@render transcriptItem(item, skipMotion)}
    {/each}
  </div>
{/if}
{#if hasSummaryRow && turn.tail.length > 0}
  <div class="turn-rule"></div>
{/if}
{#each turn.tail as item (itemKey(item))}
  {@render transcriptItem(item, skipMotion)}
{/each}
<!-- §17's transient endings, in the place they happened: after
   everything the turn produced, never in front of it. -->
{#if !live && turn.end && turn.end.kind !== "failed"}
  <TurnEndDivider
    end={turn.end}
    onRetry={isLastTurn ? onRetry : undefined}
    {skipMotion}
  />
{/if}
<!-- Only when nothing else is reporting the run: a tool group at
   the tail already carries the spinner. -->
{#if working && needsLiveRow(turn)}
  <TurnActivityRow
    {turn}
    live
    {activityLabel}
    turnStart={turnStart}
    backgroundWait={describeBackgroundWait(turn.body)}
    expanded={false}
    attempt={attempt}
    onToggle={() => {}}
  />
{/if}
{/if}

<style>
  .turn-body.is-folded { display: none; }
  .turn-body.is-open { margin-left: 0.9375rem; padding-left: 0.75rem; border-left: 0.0625rem solid color-mix(in oklch, var(--foreground) 9%, transparent); }
  .turn-rule { height: 0.0625rem; margin: 0 0 0.75rem; background: color-mix(in oklch, var(--foreground) 8%, transparent); }
</style>
