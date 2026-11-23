<script lang="ts">
  import type { Snippet } from "svelte";
  import type { StatusCardState, TurnStartKind } from "@solus/contracts/types";
  import type { ToolHistoryStore } from "../../contexts/workspace/tool-history.store";
  import type { ReplySegment } from "@solus/client-core/reply-pull-requests";
  import { getSettingsContext, getWorkspaceContext } from "../../contexts";
  import { sessionArtifactsStore } from "../../contexts/sessions/session-artifacts.store.svelte";
  import { turnReplyCards } from "./lib/turn-reply-cards";
  import { NO_BURST, type UserBurst } from "./lib/user-burst";
  import { type Turn, type GroupedItem, itemKey, needsLiveRow, shouldAnimateTurnEntry, visibleTurnBody } from "./lib/turns";
  import { describeBackgroundWait, settledBackgroundWait } from "./lib/activity-summary";
  import BackgroundWorkRow from "./BackgroundWorkRow.svelte";
  import McpTaskRows from "./McpTaskRows.svelte";
  import ResourceWatchRows from "./ResourceWatchRows.svelte";
  import { mcpStore } from "../../contexts/mcp";
  import { shownBackgroundRecords } from "@solus/client-core/background-item";
  import { MCP_TASKS } from "@solus/client-core/mcp-task-row";
  import { RESOURCE_WATCHES } from "@solus/client-core/resource-watch-row";
  import { runHost } from "../../contexts/workspace/run-location";
  import TurnActivityRow from "./TurnActivityRow.svelte";
  import StatusCard from "./StatusCard.svelte";
  import TurnBody from "./TurnBody.svelte";
  import TurnEndDivider from "./TurnEndDivider.svelte";
  import ToolInputStatus from "./ToolInputStatus.svelte";
  import TurnArtifacts from "./TurnArtifacts.svelte";
  import TurnImageGallery from "./TurnImageGallery.svelte";
  import ThoughtRow from "./ThoughtRow.svelte";
  import ToolGroupItem from "./ToolGroupItem.svelte";
  import ToolOutputStrip from "./ToolOutputStrip.svelte";
  import { EMPTY_TOOL_STRIP, hasToolStrip, toolStrip } from "@solus/client-core/tool-outputs";
  import { focusToolLine, toolGroupOf, turnStripTools } from "./lib/tool-output-strip";
  import { getTranscriptDisclosure } from "./lib/transcript-disclosure.svelte";
  import { openToolLine, toolGroupKey } from "./lib/open-tool-lines";
  import McpAppLiveCard from "./McpAppLiveCard.svelte";
  import { mcpAppLiveToolName } from "@solus/contracts/mcp-apps";
  import { measureMount } from "../../lib/mount-timing";
  measureMount("ConversationTurn");
  let { turn, burst = NO_BURST, index, total, expanded, isAwaitingInput, activityLabel, setupLabel, turnStart, attempt,
    hasBackgroundWork = false, onStopBackgroundWork = async () => {}, history, onToggle, onRetry, transcriptItem, serverId,
    settledSetupCard, tabId, nextStartedAt = null }: {
    turn: Turn;
    /** Whether this turn's prompt sits in a burst of one person's messages. */
    burst?: UserBurst; index: number; total: number; expanded: boolean; isAwaitingInput: boolean;
    activityLabel?: string;
    /** The setup step that runs now, while the session's setup card is active. */
    setupLabel?: string; turnStart: TurnStartKind | null; attempt: number;
    /** The session's turn ended, but a task it launched is still running. */
    hasBackgroundWork?: boolean; onStopBackgroundWork?: () => Promise<void>; history: ToolHistoryStore;
    onToggle: (expanded: boolean) => void; onRetry: () => void;
    /** The fourth argument splits the final reply around its pull request cards. */
    transcriptItem: Snippet<[GroupedItem, boolean, UserBurst?, ReplySegment[]?]>;
    /** The session's host, for naming who stopped a turn. */
    serverId?: string;
    /** The setup this turn's send ran, once it finished: drawn after the prompt. */
    settledSetupCard?: StatusCardState;
    tabId: string;
    /** When the next turn started; null on the last turn. */
    nextStartedAt?: number | null;
  } = $props();
  const settings = getSettingsContext();
  const body = $derived(visibleTurnBody(turn, settings.showToolCalls));
  const items = $derived([...body, ...turn.tail]);
  const session = getWorkspaceContext();
  // A pull request the turn linked and its final reply mentions shows as a
  // card in the reply; the rest stay chips at the turn's end.
  const replyCards = $derived(
    turn.live ? null : turnReplyCards(turn, sessionArtifactsStore.artifactsFor(session.sessionFor(tabId)?.id)?.own ?? [], nextStartedAt),
  );
  const NO_PLACED_PULL_REQUESTS: ReadonlySet<string> = new Set();
  // The session's MCP tasks and resource watches show on its last turn: the live
  // ones, and those that ended during it.
  const ownSessionId = $derived(session.sessionFor(tabId)?.id);
  const ownServerId = $derived(runHost(session.sessionFor(tabId)?.run));
  $effect(() => {
    if (index !== total - 1 || !ownSessionId || !ownServerId) return;
    mcpStore.tasks.follow(ownServerId, ownSessionId);
    mcpStore.watches.follow(ownServerId, ownSessionId);
  });
  const mcpTasks = $derived(index === total - 1 ? shownBackgroundRecords(MCP_TASKS, mcpStore.tasks.recordsOf(ownSessionId), turn.startedAt) : []);
  const resourceWatches = $derived(
    index === total - 1 ? shownBackgroundRecords(RESOURCE_WATCHES, mcpStore.watches.recordsOf(ownSessionId), turn.startedAt) : [],
  );
  // A live MCP task holds the session in `background`. The row of the agent's own
  // background work then says nothing the MCP task rows do not, unless the turn waits on more.
  const backgroundWorkIsMcpTasks = $derived(mcpTasks.some(MCP_TASKS.isLive) && describeBackgroundWait(turn.body) === null);
  // The folded turn's outputs strip. It reads the turn's own calls, and only while folded.
  const disclosure = getTranscriptDisclosure();
  const outputs = $derived(turn.live || expanded ? EMPTY_TOOL_STRIP : toolStrip(turnStripTools(turn)));

  function openToolOutput(toolId: string, chip: HTMLElement): void {
    const group = toolGroupOf(turn, toolId);
    if (!group) return;
    onToggle(false);
    openToolLine(disclosure, toolGroupKey(group[0]?.id), toolId);
    void history.load(group);
    void focusToolLine(chip, toolId);
  }
</script>

{#snippet outputStrip()}<ToolOutputStrip strip={outputs} onOpen={openToolOutput} />{/snippet}

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
  {@render transcriptItem(turn.lead, skipMotion, burst)}
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
    strip={hasToolStrip(outputs) ? outputStrip : undefined}
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
  <div class="turn-items space-y-(--turn-item-gap)">
    {#if body.length > 0 && expanded && settings.showToolCalls}
      <div class="turn-item" class:is-open={!live}><ToolInputStatus tools={turn.tools} history={history} /></div>
    {/if}
    {#each items as item, itemIdx (itemKey(item))}
      {@const folds = itemIdx < body.length && !turn.visibleWhenCollapsed.includes(item)}
      <div
        class="turn-item"
        data-body-kind={itemIdx < body.length ? item.kind : undefined}
        hidden={folds && !live && !expanded}
        class:is-open={itemIdx < body.length && !live && expanded}
      >
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
            <!-- A Solus integration tool can show its MCP App while its call
               runs. The turn folds its tools when it ends, so the card goes
               then and the saved card of the call shows the app. -->
            {#if live}
              {#each item.messages as tool (tool.id)}
                {@const liveToolName = mcpAppLiveToolName(tool.toolName)}
                {@const liveSession = session.sessionFor(tabId)}
                {#if liveToolName && liveSession}
                  <McpAppLiveCard
                    message={tool}
                    toolName={liveToolName}
                    sessionId={liveSession.id}
                    {tabId}
                    onSend={(text) => session.dispatch.sendMessage(text, undefined, tabId, "queue")}
                  />
                {/if}
              {/each}
            {/if}
          {:else if item.kind === "thought"}
            <ThoughtRow message={item.message} {skipMotion} live={working && itemIdx === body.length - 1} />
          {:else}
            {@render transcriptItem(
              item,
              skipMotion,
              undefined,
              item.kind === "assistant" && item.message.id === replyCards?.replyId ? replyCards.segments : undefined,
            )}
          {/if}
        </TurnBody>
      </div>
    {/each}
  </div>
{/if}
<TurnImageGallery messages={turn.images} {serverId} />
{#if !live}
  <TurnArtifacts {turn} {nextStartedAt} {tabId} placedPullRequests={replyCards?.placed ?? NO_PLACED_PULL_REQUESTS} />
{/if}
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
{#if hasBackgroundWork && isLastTurn && !live && !backgroundWorkIsMcpTasks}
  <BackgroundWorkRow wait={settledBackgroundWait(turn.body)} onStop={onStopBackgroundWork} />
{/if}
{#if mcpTasks.length}
  <McpTaskRows {tabId} tasks={mcpTasks} />
{/if}
<!-- Its resource watches show there too. A watch waits for news, so it does not hold `background`. -->
{#if resourceWatches.length}
  <ResourceWatchRows {tabId} watches={resourceWatches} />
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
  .turn-items { --turn-item-gap: 0.5rem; }
  @container pane (width < 30rem) {
    .turn-items { --turn-item-gap: 0.75rem; }
  }
  /* An activity row's chassis already pads 7px above and below its label, so
     text beside a tool group takes a smaller item gap: the padding makes up
     the rest. */
  .turn-item[data-body-kind="tool-group"]:has(+ .turn-item[data-body-kind="assistant"]:not([hidden])),
  .turn-item[data-body-kind="assistant"]:has(+ .turn-item[data-body-kind="tool-group"]:not([hidden])) {
    --turn-item-gap: 0.25rem;
  }

  /* The open body's rail: each item draws its own edge, and an item followed
     by another open item bridges the gap between them. */
  .turn-item.is-open { position: relative; margin-left: 0.9375rem; padding-left: 0.75rem; border-left: 0.0625rem solid color-mix(in oklch, var(--foreground) 9%, transparent); }
  /* A message's hover rail hangs left of the rule, not across it, and the
     margin left for it is the indent narrower. */
  .turn-item.is-open { --hover-rail-clear: 0.8125rem; --hover-rail-indent: 1.75rem; }
  .turn-item.is-open:has(+ .turn-item.is-open)::after { content: ""; position: absolute; left: -0.0625rem; top: 100%; width: 0.0625rem; height: var(--turn-item-gap); background: color-mix(in oklch, var(--foreground) 9%, transparent); }
  .turn-rule { height: 0.0625rem; margin: 0 0 0.75rem; background: color-mix(in oklch, var(--foreground) 8%, transparent); }
</style>
