<script lang="ts">
  import { tick } from "svelte";
  import {
    Check as CheckIcon,
    CircleAlert as WarningCircleIcon,
    LoaderCircle as SpinnerIcon,
  } from "@lucide/svelte";
  import { SubagentHistoryStore, type SubagentHistoryState } from "@solus/client-core/subagent-history-store";
  import { providerSubagentMessages } from "./lib/subagent-history";
  import { getSessionRecords, getSurfaceContext } from "../../contexts";
  import CopyButton from "../ui/CopyButton.svelte";
  import { underStrip } from "../ui/lib/pane-strip";
  import RecordTranscript from "../session/record/RecordTranscript.svelte";
  import { subagentConversation } from "./lib/subagent-view";
  import { subagentLiveStep, subagentRow } from "./lib/subagent-group";
  import { formatActivityDuration } from "./lib/activity-summary";
  import { subagentTranscriptText } from "./lib/tool-trace";
  import { liveActivityClock } from "../../lib/shared-clock";
  import { runHost, workingPlace } from "../../contexts/workspace/run-location";

  /**
   * A sub-agent's run, read as a conversation: the brief the main agent wrote,
   * then what the sub-agent did and said. There is no input bar — a sub-agent
   * takes no prompts from here. Expand and close stay with PaneChrome's
   * floating cluster.
   */
  interface Props {
    sessionId: string;
    messageId: string;
  }
  let { sessionId, messageId }: Props = $props();

  const sessions = getSessionRecords();
  const surface = getSurfaceContext();
  // The companion strip draws the seam for the pane it heads.
  const isUnderStrip = underStrip();

  const currentSession = $derived(sessions.byId[sessionId]);
  const message = $derived(
    currentSession?.messages.find((m) => m.id === messageId),
  );

  // A call without recorded child rows reads its provider history from the
  // host. The store is keyed on plain values, so an unrelated change to the
  // run does not start a new read.
  const toolId = $derived(message?.toolId);
  const provider = $derived(currentSession?.run.provider);
  const projectPath = $derived(currentSession ? workingPlace(currentSession.run).path : undefined);
  const history = $derived(
    toolId && provider
      ? new SubagentHistoryStore(surface.apiForSession(sessionId), { sessionId, toolId, provider, projectPath })
      : null,
  );
  let saved = $state<SubagentHistoryState | null>(null);
  $effect(() => {
    if (!history || message?.subMessages?.length) return;
    const source = history;
    const read = () => {
      saved = source.read();
    };
    const unsubscribe = source.subscribe(read);
    read();
    void source.load();
    return unsubscribe;
  });

  let now = $state(Date.now());
  // Read off the message, not off `row` — a clock the row depends on would
  // tear down and rebuild its own subscription on every tick.
  const running = $derived(message?.toolStatus === "running");
  $effect(() => {
    if (!running) return;
    return liveActivityClock.subscribe((value) => { now = value; });
  });

  const row = $derived(
    message
      ? subagentRow(message, now, {
          model: (
            currentSession?.sessionModel ||
            currentSession?.run.modelConfig.modelId ||
            ""
          ).trim(),
          effort: (currentSession?.run.modelConfig.reasoningEffort || "").trim(),
        })
      : null,
  );
  const restored = $derived(saved ? providerSubagentMessages(saved.page.messages) : []);
  const childMessages = $derived(message?.subMessages?.length ? message.subMessages : restored);
  // A live run keeps its own rows; only a restored run is given the read ones.
  const messages = $derived(
    !message ? []
      : message.subMessages?.length ? subagentConversation(message)
        : subagentConversation({ ...message, subMessages: restored }),
  );
  const liveStep = $derived(message && running ? subagentLiveStep(message) : null);
  const copyText = $derived(
    message ? subagentTranscriptText(childMessages) : "",
  );

  // Follow a live run while the reader is at the end; leave them where they
  // are once they scroll up.
  let scroller = $state<HTMLDivElement | null>(null);
  let followsEnd = true;
  function onScroll() {
    if (!scroller) return;
    followsEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
  }
  $effect(() => {
    void messages.length;
    void liveStep?.activity;
    if (!scroller || !followsEnd) return;
    void tick().then(() => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
  });
</script>

<div
  class="text-sm flex h-full min-h-0 min-w-0 flex-col bg-(--solus-container-bg) {isUnderStrip()
    ? ''
    : 'border-l border-(--solus-container-border)'}"
>
  <!-- The chrome row. Its gutter is a margin, not padding: this row is a window
       drag region, and a drag rect that reached under PaneChrome's cluster
       would swallow its clicks as window moves. -->
  <div
    class="workspace-titlebar flex h-(--solus-chrome-row-h,2.5rem) min-w-0 shrink-0 items-center gap-2.5 mr-[max(0.75rem,var(--solus-pane-chrome-inset,0px))] pl-[max(0.75rem,var(--solus-chrome-lead-inset,0px))]"
  >
    {#if row}
      <span class="inline-flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
        {#if row.state === "running"}
          <SpinnerIcon size={14} class="text-(--solus-status-running) motion-safe:animate-spin" />
        {:else if row.state === "failed"}
          <WarningCircleIcon size={14} class="text-(--solus-status-error)" />
        {:else}
          <CheckIcon size={14} class="text-(--solus-status-complete)" />
        {/if}
      </span>
      <h2 class="m-0 min-w-0 flex-1 truncate leading-tight font-medium">{row.name}</h2>
      <span class="no-drag shrink-0 text-xs tabular-nums text-(--solus-text-tertiary)"
        >{formatActivityDuration(row.elapsedMs)}</span
      >
      <span class="no-drag shrink-0">
        <CopyButton text={copyText} title="Copy transcript" />
      </span>
    {/if}
  </div>

  {#if message}
    <div class="min-h-0 flex-1 overflow-y-auto" bind:this={scroller} onscroll={onScroll}>
      <div class="mx-auto flex w-full max-w-(--solus-reading-max) flex-col px-6 pt-4 pb-8">
        {#if !message.subMessages?.length && history}
          <div class="mb-3 flex min-h-11 items-center gap-4 text-workspace-chrome text-(--solus-text-tertiary)">
            <button
              type="button"
              class="min-h-11 hover:text-(--solus-text-primary)"
              disabled={saved?.phase === "loading"}
              onclick={() => void history?.load()}
            >
              {saved?.phase === "loading" ? "Loading activity…" : "Refresh activity"}
            </button>
            {#if saved?.page.before}
              <button
                type="button"
                class="min-h-11 hover:text-(--solus-text-primary)"
                disabled={saved.phase === "loading"}
                onclick={() => void history?.load(true)}
              >
                Load earlier
              </button>
            {/if}
          </div>
          {#if saved?.phase === "error"}
            <p role="alert" class="mb-3 text-(--solus-status-error)">{saved.error}</p>
          {/if}
        {/if}
        <RecordTranscript
          {messages}
          serverId={runHost(currentSession?.run) ?? ""}
          planFor={() => undefined}
          workFor={() => undefined}
        />
        {#if liveStep}
          <!-- What the agent is doing this second. -->
          <div class="flex min-w-0 items-baseline gap-2 py-2" data-testid="subagent-live-step">
            <span class="activity-shimmer shrink-0">{liveStep.activity}</span>
            {#if liveStep.target}
              <span class="min-w-0 truncate text-xs text-(--solus-text-tertiary)">{liveStep.target}</span>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {:else}
    <div class="px-4 py-6 text-(--solus-text-tertiary)">
      This sub-agent is no longer available.
    </div>
  {/if}
</div>
