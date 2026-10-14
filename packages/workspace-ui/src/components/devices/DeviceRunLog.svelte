<script lang="ts">
  import { tick } from "svelte";
  import { ChevronDown, CircleCheck, CircleX, Copy, Hammer, TriangleAlert, X } from "@lucide/svelte";
  import { isDeviceRunActive } from "@solus/contracts/device-types";
  import { devicesStore, deviceErrorMessage } from "../../contexts/devices/devices.store.svelte";
  import { copyText, toasts } from "../../lib/toasts";
  import { Button } from "../ui/button";
  import { formatRunElapsed, rawLineTone, readRunLog } from "@solus/client-core/device-run-log";
  import { runStageLabel } from "@solus/client-core/device-builds";

  /**
   * One build-and-run's output under the device toolbar (plan 016, S02). The
   * host keeps the newest part of the log; this reads it once a second while
   * the build runs and the pane is visible, and once when it ends. It is one
   * status row — stage, current step, issues, time — so the device keeps the
   * room; the log opens below it on request, and by itself when a build fails.
   */
  interface Props {
    serverId: string;
    runId: string;
    visible: boolean;
    /** Without it the build has no close control. */
    onClose?: () => void;
    /** Its frame: a band under the device toolbar by default, a card on the Builds page. */
    class?: string;
  }

  type LogView = "steps" | "issues" | "raw";

  let { serverId, runId, visible, onClose, class: frame = "max-h-[45%] border-b border-[var(--hairline)] bg-[var(--card)]" }: Props = $props();

  const run = $derived(devicesStore.runs(serverId).find((candidate) => candidate.runId === runId));
  const isActive = $derived(!!run && isDeviceRunActive(run));
  const exists = $derived(!!run);
  let text = $state("");
  let truncated = $state(false);
  let now = $state(Date.now());
  /** What the reader picked; until then only a failed build opens its log. */
  let chosenOpen = $state<boolean | null>(null);
  /** What the reader picked; until then a failed build with errors shows its issues. */
  let chosenView = $state<LogView | null>(null);
  let output = $state<HTMLElement | null>(null);
  const steps = $derived(readRunLog(text));
  const issues = $derived(steps.filter((step) => step.tone === "error" || step.tone === "warning"));
  const errors = $derived(issues.filter((step) => step.tone === "error").length);
  const warnings = $derived(issues.length - errors);
  const currentStep = $derived(steps.findLast((step) => step.tone === "step"));
  const isOpen = $derived(chosenOpen ?? run?.stage === "failed");
  const elapsed = $derived(run ? formatRunElapsed((run.endedAt ?? now) - run.startedAt) : "");
  const view = $derived<LogView>(steps.length === 0 ? "raw" : (chosenView ?? (run?.stage === "failed" && errors > 0 ? "issues" : "steps")));
  const shownSteps = $derived(view === "issues" ? issues : steps);
  const rawLines = $derived(view === "raw" ? text.split("\n").map((line) => ({ line, tone: rawLineTone(line) })) : []);
  const tabs = $derived<{ key: LogView; label: string }[]>([
    { key: "steps", label: "Steps" },
    { key: "issues", label: issues.length ? `Issues (${issues.length})` : "Issues" },
    { key: "raw", label: "Raw output" },
  ]);

  $effect(() => {
    if (!visible || !exists) return;
    let stopped = false;
    const read = () => devicesStore.runLog(serverId, runId).then((log) => {
      if (stopped) return;
      const lines = log.text.split("\n");
      // Follow new output only while the reader is at the end.
      const isAtEnd = !output || output.scrollHeight - output.scrollTop - output.clientHeight < 24;
      now = Date.now();
      text = lines.slice(-400).join("\n");
      truncated = log.truncated || lines.length > 400;
      if (isAtEnd) queueMicrotask(() => output?.scrollTo({ top: output.scrollHeight }));
    }, () => {});
    void read();
    const timer = isActive ? setInterval(() => void read(), 1_000) : null;
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
    };
  });

  /** Open the log at its newest lines. */
  function openLog(next: LogView | null = chosenView) {
    chosenOpen = true;
    chosenView = next;
    void tick().then(() => output?.scrollTo({ top: output.scrollHeight }));
  }

  function copyLog() {
    void copyText(text).then(() => toasts.success("Build log copied"), () => toasts.error("Couldn't copy the build log"));
  }

  function cancel() {
    void devicesStore.cancelRun(serverId, runId).catch((cause: unknown) => toasts.error("Couldn't cancel the build", { description: deviceErrorMessage(cause) }));
  }
</script>

{#if run}
  <section class="flex min-h-0 shrink-0 flex-col overflow-hidden {frame}" aria-label="Build" data-failed={run.stage === "failed" || undefined} data-testid="device-run-log">
    <!-- The transcript card shell (docs/transcript-cards.md): the glyph carries
         the state, so the title stays in the text colour. -->
    <header class="flex min-h-[var(--tx-card-head)] shrink-0 items-center gap-[var(--tx-card-gap)] py-1.5 pr-[var(--tx-card-pad-r)] pl-[var(--tx-card-pad-l)]">
      <span class="flex size-[var(--tx-card-glyph)] shrink-0 items-center justify-center" aria-hidden="true">
        {#if run.stage === "failed"}
          <CircleX class="size-3.5 text-[color:color-mix(in_oklch,var(--destructive)_70%,var(--foreground))]" />
        {:else if run.stage === "done"}
          <CircleCheck class="size-3.5 text-[color:color-mix(in_oklch,var(--chart-3)_70%,var(--foreground))]" />
        {:else}
          <Hammer class="size-3.5 text-(--solus-text-tertiary)" />
        {/if}
      </span>
      <div class="flex min-w-0 flex-1 flex-col">
        <span class="text-workspace-chrome truncate font-medium text-(--solus-text-primary)" role="status" aria-live="polite">{runStageLabel(run)}</span>
        <span class="text-chrome-dense truncate text-(--solus-text-tertiary)">
          {#if isActive && currentStep}{currentStep.text}{currentStep.target ? ` · ${currentStep.target}` : ""}{:else}{run.checkout}{run.branch ? ` · ${run.branch}` : ""}{run.deviceName ? ` · ${run.deviceName}` : ""}{/if}
        </span>
      </div>
      {#if errors > 0 || warnings > 0}
        <button type="button" class="text-chrome-dense flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 hover:bg-[var(--wash-2)] focus-visible:outline-2 focus-visible:outline-[var(--ring)] {errors > 0 ? 'text-[var(--failure)]' : 'text-[var(--warning)]'}"
          title="Show the issues in the log" onclick={() => openLog("issues")}>
          {#if errors > 0}<CircleX class="size-3.5" aria-hidden="true" />{errors}{/if}
          {#if warnings > 0}<TriangleAlert class="size-3.5 {errors > 0 ? 'ml-1 text-[var(--warning)]' : ''}" aria-hidden="true" /><span class={errors > 0 ? "text-[var(--warning)]" : ""}>{warnings}</span>{/if}
          <span class="sr-only">{errors} errors, {warnings} warnings</span>
        </button>
      {/if}
      <span class="text-chrome-dense shrink-0 tabular-nums text-(--solus-text-tertiary)" title="Time since the build started">{elapsed}</span>
      {#if isActive}
        <Button size="xs" variant="outline" onclick={cancel}>Cancel</Button>
      {/if}
      <Button size="xs" variant="ghost" class="text-(--solus-text-secondary)" aria-expanded={isOpen} onclick={() => (isOpen ? (chosenOpen = false) : openLog())}>
        Log<ChevronDown class="transition-transform motion-reduce:transition-none {isOpen ? 'rotate-180' : ''}" />
      </Button>
      {#if onClose}<Button size="icon-xs" variant="ghost" aria-label="Close the build" onclick={onClose}><X /></Button>{/if}
    </header>
    {#if run.error}
      <p class="text-chrome-dense pr-3 pb-2.5 pl-[var(--tx-card-body-indent)] text-[color:color-mix(in_oklch,var(--destructive)_80%,var(--foreground))]">{run.error}</p>
    {/if}
    {#if isOpen}
      <!-- The log reads like a tool row's detail in the transcript: a rule drops
           from the glyph, and the steps and output sit beside it, unboxed. -->
      <div class="mx-3 flex min-h-0 flex-col border-t-[0.5px] border-[var(--solus-tx-rule)] pb-2">
        <div class="flex shrink-0 items-center gap-3 py-1.5 pl-6">
          {#if steps.length > 0}
            <div class="flex gap-3" role="tablist" aria-label="Log view">
              {#each tabs as tab (tab.key)}
                <button type="button" role="tab" aria-selected={view === tab.key}
                  class="text-chrome-dense rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] {view === tab.key ? 'font-medium text-(--solus-text-primary)' : 'text-(--solus-text-tertiary) hover:text-(--solus-text-secondary)'}"
                  onclick={() => (chosenView = tab.key)}>{tab.label}</button>
              {/each}
            </div>
          {:else}
            <span class="text-chrome-dense text-(--solus-text-tertiary)">Output</span>
          {/if}
          <Button size="icon-xs" variant="ghost" class="ml-auto text-(--solus-text-tertiary)" aria-label="Copy the build log" title="Copy the build log" disabled={!text} onclick={copyLog}><Copy /></Button>
        </div>
        {#if view === "raw"}
          <!-- Raw output reads as a terminal: dark in both themes, mono, and
               problem lines in colour. The cursor shows while the run writes. -->
          <div bind:this={output} class="ml-[0.6875rem] max-h-72 min-h-0 overflow-auto rounded-lg bg-[var(--solus-terminal-bg)] px-[0.8125rem] py-3 font-mono text-tool-step leading-[1.6] text-[var(--solus-terminal-fg)] shadow-[shadow:0_0_0_0.03125rem_var(--solus-terminal-border)] selection:bg-[color:color-mix(in_oklch,var(--solus-terminal-fg)_25%,transparent)]" role="log" aria-label="Raw output">
            {#if truncated}<p class="text-[var(--solus-terminal-dim)]">… earlier output is not kept</p>{/if}
            {#if !text}
              <p class="text-[var(--solus-terminal-dim)]">{isActive ? "Waiting for output" : "No output."}{#if isActive}<span class="ml-1 inline-block h-[1.1em] w-[0.55em] translate-y-[0.2em] bg-[var(--solus-terminal-fg)] opacity-70" aria-hidden="true"></span>{/if}</p>
            {:else}
              <pre class="break-words whitespace-pre-wrap">{#each rawLines as { line, tone }, index (index)}<span class={tone === "error" ? "text-[var(--solus-terminal-error)]" : tone === "warning" ? "text-[var(--solus-terminal-warning)]" : ""}>{line}</span>{"\n"}{/each}{#if isActive}<span class="inline-block h-[1.1em] w-[0.55em] translate-y-[0.2em] bg-[var(--solus-terminal-fg)] opacity-70" aria-hidden="true"></span>{/if}</pre>
            {/if}
          </div>
        {:else}
        <div bind:this={output} class="ml-[0.6875rem] max-h-64 min-h-0 overflow-auto border-l border-[color:color-mix(in_oklch,var(--foreground)_9%,transparent)] pl-3">
          {#if truncated}
            <p class="text-tool-step pb-1 text-(--solus-text-tertiary)">Earlier output is not kept.</p>
          {/if}
          {#if !text}
            <p class="text-tool-step py-1 text-(--solus-text-tertiary)">{isActive ? "Waiting for output…" : "No output."}</p>
          {:else if shownSteps.length === 0}
            <p class="text-tool-step py-1 text-(--solus-text-tertiary)">No errors or warnings{isActive ? " yet" : ""}.</p>
          {:else}
            <ol>
              {#each shownSteps as step, index (index)}
                <li class="text-tool-step flex min-w-0 items-start gap-2.5 py-1 {step.tone === 'step' && !(view === 'steps' && index === steps.length - 1 && isActive) ? 'text-muted-foreground' : 'text-(--solus-text-primary)'}">
                  <span class="flex h-4 w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
                    {#if step.tone === "error"}
                      <CircleX class="size-3 text-[color:color-mix(in_oklch,var(--destructive)_70%,var(--foreground))]" />
                    {:else if step.tone === "warning"}
                      <TriangleAlert class="size-3 text-[var(--warning)]" />
                    {:else}
                      <span class="size-1 rounded-full bg-current opacity-50"></span>
                    {/if}
                  </span>
                  <span class="min-w-0 flex-1 {step.tone === 'step' ? 'truncate' : 'break-words'}">{step.text}</span>
                  {#if step.target}
                    <span class="max-w-[40%] shrink-0 truncate font-mono text-(--solus-text-tertiary)">{step.target}</span>
                  {/if}
                </li>
              {/each}
            </ol>
          {/if}
        </div>
        {/if}
      </div>
    {/if}
  </section>
{/if}
