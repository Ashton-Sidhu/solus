<script lang="ts">
  import { CheckIcon, WarningCircleIcon } from "phosphor-svelte";
  import {
    getSessionEnvironmentStore,
    getWorkspaceContext,
  } from "../../contexts";
  import CopyButton from "../ui/CopyButton.svelte";
  import SubagentReport from "./SubagentReport.svelte";
  import SubagentTranscript from "./SubagentTranscript.svelte";
  import {
    reportText,
    subagentFooter,
    subagentHeader,
    subagentProgress,
  } from "./lib/subagent-view";
  import { subagentTranscriptText } from "./lib/tool-trace";

  /**
   * A subagent is one agent doing one task in a single turn, so the pane holds two
   * views over that turn: the **report** — the answer, which is why the reader
   * opened it — and the **transcript**, the run that produced it. The header
   * carries one metadata sentence rather than a row of pills, and expand/close
   * stay with PaneChrome's floating cluster instead of being restated here.
   *
   * §5 — one progress line sits under the header in every state and survives the
   * run: live it says how far through the brief the agent is, settled it becomes
   * the record of what the run cost. The footer answers the other question — what
   * the agent is doing this second — and only the Report tab carries it, because
   * the Transcript is already that stream.
   */
  interface Props {
    tabId: string;
    messageId: string;
  }
  let { tabId, messageId }: Props = $props();

  const session = getWorkspaceContext();
  const environments = getSessionEnvironmentStore();

  const currentSession = $derived(session.sessionFor(tabId));
  const message = $derived(
    currentSession?.messages.find((m) => m.id === messageId),
  );
  const environment = $derived(environments.environmentFor(tabId));

  let now = $state(Date.now());
  const header = $derived(
    message
      ? subagentHeader(
          message,
          {
            model: (
              currentSession?.sessionModel ||
              currentSession?.modelConfig.modelId ||
              ""
            ).trim(),
            effort: (currentSession?.modelConfig.reasoningEffort || "").trim(),
          },
          environment.isolated ? environment.name : "",
          now,
        )
      : null,
  );
  const running = $derived(header?.state === "running");
  const progress = $derived(message ? subagentProgress(message, now) : null);
  const footer = $derived(message && running ? subagentFooter(message) : null);
  // Read off the message, not off `header` — a clock the header depends on would
  // tear down and rebuild its own interval on every tick.
  $effect(() => {
    if (message?.toolStatus !== "running") return;
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  const blocks = $derived(message?.subMessages?.length ?? 0);

  // A running agent has no answer yet, so it opens on the run; a settled one opens
  // on what it concluded. Either way the reader's own choice wins from then on.
  let chosenView = $state<"report" | "transcript" | null>(null);
  const view = $derived(chosenView ?? (running ? "transcript" : "report"));

  // Lazy-mount each view once, then hide it: switching tabs must not re-parse the
  // report's markdown or rebuild the transcript's rows.
  let hasMountedReport = $state(false);
  let hasMountedTranscript = $state(false);
  $effect(() => {
    if (view === "report") hasMountedReport = true;
    else hasMountedTranscript = true;
  });

  const copyText = $derived.by(() => {
    if (!message) return "";
    if (view === "report") return reportText(message);
    return subagentTranscriptText(message.subMessages ?? []);
  });
</script>

<!-- Run facts read as one rail wherever they appear: mono, tabular, and separated
     by a dot a step dimmer than the numbers it divides. -->
{#snippet factRail(clauses: string[])}
  {#each clauses as clause, i (i)}
    {#if i > 0}
      <span
        class="shrink-0 text-[0.6875rem] text-(--muted-foreground) opacity-40"
        aria-hidden="true">·</span
      >
    {/if}
    <span
      class="shrink-0 font-mono text-[0.6875rem] text-(--muted-foreground) tabular-nums opacity-75"
      >{clause}</span
    >
  {/each}
{/snippet}

<div
  class="flex h-full min-h-0 min-w-0 flex-col border-l border-(--solus-container-border) bg-(--solus-container-bg)"
>
  <!-- The chrome row: `‹ Subagents` on the traffic-light side, PaneChrome's
       expand/close floating on the other. Both insets are published by the pane
       column, so the two clusters sit on one optical line. -->
  <div
    class="flex h-(--solus-chrome-row-h,2.5rem) shrink-0 items-center pr-[max(0.75rem,var(--solus-pane-chrome-inset,0px))] pl-[max(0.75rem,var(--solus-chrome-lead-inset,0px))]"
  >
    <h2
      class="m-0 text-[1.03rem] leading-tight font-semibold tracking-[-0.021em]"
    >
      {#if message && header}
        {header.title}
      {/if}
    </h2>
  </div>

  {#if message && header && progress}
    <!-- Progress holds one line under the header in every state. The unit is the
         agent's own plan when it kept one, else the asks the dispatch enumerated:
         the segments exist as soon as the brief does, and fill only where a real
         denominator says they may. -->
    <div class="flex shrink-0 items-center gap-2.5 px-[1.125rem] pb-2.5">
      <span class="flex shrink-0 items-center gap-2">
        <span
          class="inline-flex w-3.5 shrink-0 items-center justify-center {progress.state ===
          'failed'
            ? 'text-[color-mix(in_oklch,var(--destructive)_70%,var(--foreground))]'
            : progress.state === 'done'
              ? 'text-[color-mix(in_oklch,var(--solus-art-3)_62%,var(--foreground))]'
              : 'text-(--muted-foreground)'}"
          aria-hidden="true"
        >
          {#if progress.state === "running"}
            <span class="activity-spinner"></span>
          {:else if progress.state === "failed"}
            <WarningCircleIcon size={11} weight="regular" />
          {:else}
            <CheckIcon size={11} weight="bold" />
          {/if}
        </span>
        <span class="text-[0.78125rem] font-medium">{progress.label}</span>
      </span>

      {#if progress.segments.length > 0}
        <span
          class="flex max-w-[11.5rem] shrink items-center gap-[0.1875rem]"
          aria-hidden="true"
        >
          {#each progress.segments as segment, i (i)}
            <span
              class="h-[0.1875rem] min-w-[0.375rem] shrink grow-0 basis-[1.625rem] overflow-hidden rounded-full {segment.status ===
              'done'
                ? 'bg-[color-mix(in_oklch,var(--foreground)_62%,transparent)]'
                : segment.status === 'stopped'
                  ? 'bg-[color-mix(in_oklch,var(--destructive)_50%,transparent)]'
                  : 'bg-[color-mix(in_oklch,var(--foreground)_12%,transparent)]'}"
            >
              {#if segment.status === "active"}
                <!-- The step in flight has no denominator of its own, so it fills
                     by the calls spent on it and never reaches the end. -->
                <span
                  class="block h-full rounded-full bg-(--primary) transition-[width] duration-500 ease-out"
                  style="width:{segment.fill}%"
                ></span>
              {/if}
            </span>
          {/each}
        </span>
      {/if}

      {#if progress.current}
        <span class="min-w-0 truncate text-[0.78125rem] text-(--muted-foreground)"
          >{progress.current}</span
        >
      {/if}

      <span class="flex-1"></span>
      {@render factRail(progress.facts)}
    </div>

    <!-- An underline, not a segmented control: the two views are the same turn
         read two ways, so neither should look like a mode you switch into. -->
    <div
      class="flex shrink-0 items-baseline gap-[1.125rem] border-b border-[color-mix(in_oklch,var(--foreground)_12%,transparent)] px-[1.125rem]"
      role="tablist"
      aria-label="Sub-agent views"
    >
      <button
        type="button"
        role="tab"
        aria-selected={view === "report"}
        class="flex cursor-pointer items-baseline gap-1.5 border-none bg-transparent px-0 pt-0 pb-[0.5625rem] text-[0.78rem] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-(--solus-accent-border) focus-visible:outline-none {view ===
        'report'
          ? 'shadow-[shadow:inset_0_-1.5px_0_0_var(--foreground)]'
          : 'text-(--muted-foreground) hover:text-(--foreground)'}"
        onclick={() => (chosenView = "report")}
      >
        <span>Report</span>
        {#if progress.fraction}
          <!-- The same fraction the progress line carries, so the count stays
               visible from the Transcript tab. -->
          <span
            class="font-mono text-[0.6875rem] text-(--muted-foreground) tabular-nums"
            >{progress.fraction}</span
          >
        {/if}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={view === "transcript"}
        class="flex cursor-pointer items-baseline gap-1.5 border-none bg-transparent px-0 pt-0 pb-[0.5625rem] text-[0.78rem] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-(--solus-accent-border) focus-visible:outline-none {view ===
        'transcript'
          ? 'shadow-[shadow:inset_0_-1.5px_0_0_var(--foreground)]'
          : 'text-(--muted-foreground) hover:text-(--foreground)'}"
        onclick={() => (chosenView = "transcript")}
      >
        <span>Transcript</span>
        {#if blocks > 0}
          <span class="font-mono text-[0.6875rem] tabular-nums">{blocks}</span>
        {/if}
      </button>
      <span class="flex-1"></span>
      <div class="pb-1.5">
        <CopyButton
          text={copyText}
          title={view === "report" ? "Copy report" : "Copy transcript"}
        />
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto">
      {#if hasMountedReport}
        <div role="tabpanel" class:view-hidden={view !== "report"}>
          <SubagentReport {message} {running} />
        </div>
      {/if}
      {#if hasMountedTranscript}
        <div role="tabpanel" class:view-hidden={view !== "transcript"}>
          <SubagentTranscript
            {message}
            onOpenReport={() => (chosenView = "report")}
          />
        </div>
      {/if}
    </div>

    {#if footer && view === "report"}
      <!-- What the agent is doing this second — a different question from how far
           through the brief it is, and the only moving text in the pane. The
           Transcript tab is already this stream, so only Report carries it. -->
      <div
        class="flex shrink-0 items-center gap-2.5 border-t border-[color-mix(in_oklch,var(--foreground)_12%,transparent)] px-[1.125rem] py-2"
      >
        <span class="activity-shimmer shrink-0 text-[0.78125rem]"
          >{footer.activity}</span
        >
        {#if footer.target}
          <span
            class="min-w-0 truncate font-mono text-[0.71875rem] text-(--muted-foreground) opacity-75"
            >{footer.target}</span
          >
        {/if}
        <span class="flex-1"></span>
        {@render factRail(footer.facts)}
      </div>
    {/if}
  {:else}
    <div class="px-4 py-6 text-sm text-(--solus-text-tertiary)">
      This sub-agent is no longer available.
    </div>
  {/if}
</div>

<style>
  /* `display:none` detaches from layout and paint without unmounting, so the
     inactive view keeps its parse and its scroll position. */
  .view-hidden {
    display: none !important;
  }
</style>
