<script lang="ts">
  import { tick } from "svelte";
  import { ChevronDown, CircleCheck, CircleX, Copy, Hammer, TriangleAlert, X } from "@lucide/svelte";
  import { isDeviceRunActive } from "@solus/contracts/device-types";
  import { devicesStore, deviceErrorMessage } from "../../contexts/devices/devices.store.svelte";
  import { copyText, toasts } from "../../lib/toasts";
  import { Button } from "../ui/button";
  import { formatRunElapsed, readRunLog } from "./lib/run-log";
  import { runStageLabel } from "./lib/run-profiles";

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
    onClose: () => void;
  }

  let { serverId, runId, visible, onClose }: Props = $props();

  const run = $derived(devicesStore.runs(serverId).find((candidate) => candidate.runId === runId));
  const isActive = $derived(!!run && isDeviceRunActive(run));
  const exists = $derived(!!run);
  let text = $state("");
  let truncated = $state(false);
  let now = $state(Date.now());
  /** What the reader picked; until then only a failed build opens its log. */
  let chosenOpen = $state<boolean | null>(null);
  let chosenView = $state<"steps" | "raw">("steps");
  let output = $state<HTMLElement | null>(null);
  const steps = $derived(readRunLog(text));
  const errors = $derived(steps.filter((step) => step.tone === "error").length);
  const warnings = $derived(steps.filter((step) => step.tone === "warning").length);
  const currentStep = $derived(steps.findLast((step) => step.tone === "step"));
  const isOpen = $derived(chosenOpen ?? run?.stage === "failed");
  const elapsed = $derived(run ? formatRunElapsed((run.endedAt ?? now) - run.startedAt) : "");
  const isRawShown = $derived(steps.length === 0 || chosenView === "raw");

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
  function openLog(view: "steps" | "raw" = chosenView) {
    chosenOpen = true;
    chosenView = view;
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
  <section class="flex max-h-[45%] min-h-0 shrink-0 flex-col border-b border-[var(--hairline)] bg-[var(--card)]" aria-label="Build" data-testid="device-run-log">
    <header class="flex shrink-0 items-center gap-2.5 px-3 py-2">
      {#if run.stage === "failed"}
        <CircleX class="size-4 shrink-0 text-[var(--failure)]" aria-hidden="true" />
      {:else if run.stage === "done"}
        <CircleCheck class="size-4 shrink-0 text-[var(--success)]" aria-hidden="true" />
      {:else}
        <Hammer class="size-4 shrink-0 text-(--solus-text-tertiary)" aria-hidden="true" />
      {/if}
      <div class="flex min-w-0 flex-1 flex-col">
        <span class="text-workspace-chrome truncate font-medium {run.stage === 'failed' ? 'text-[var(--failure)]' : 'text-(--solus-text-primary)'}" role="status" aria-live="polite">{runStageLabel(run)}</span>
        <span class="text-chrome-dense truncate text-(--solus-text-tertiary)">
          {#if isActive && currentStep}{currentStep.text}{currentStep.target ? ` · ${currentStep.target}` : ""}{:else}{run.checkout}{run.branch ? ` · ${run.branch}` : ""}{run.deviceName ? ` · ${run.deviceName}` : ""}{/if}
        </span>
      </div>
      {#if errors > 0 || warnings > 0}
        <button type="button" class="text-chrome-dense flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 hover:bg-[var(--wash-2)] focus-visible:outline-2 focus-visible:outline-[var(--ring)] {errors > 0 ? 'text-[var(--failure)]' : 'text-[var(--warning)]'}"
          title="Show the issues in the log" onclick={() => openLog("steps")}>
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
      <Button size="icon-xs" variant="ghost" aria-label="Close the build" onclick={onClose}><X /></Button>
    </header>
    {#if run.error}
      <p class="text-chrome-dense mx-3 mb-2 rounded-md bg-[color-mix(in_oklab,var(--failure)_10%,transparent)] px-2.5 py-1.5 text-[var(--failure)]">{run.error}</p>
    {/if}
    {#if isOpen}
      <div class="mx-3 mb-3 flex min-h-0 flex-col overflow-hidden rounded-lg border border-[var(--hairline)] bg-[var(--wash-1)]">
        <div class="flex shrink-0 items-center gap-0.5 border-b border-[var(--hairline)] px-1.5 py-1">
          <div class="flex gap-0.5" role="tablist" aria-label="Log view">
            <Button size="xs" variant="ghost" role="tab" aria-selected={!isRawShown} disabled={steps.length === 0}
              class={!isRawShown ? "bg-[var(--wash-2)] text-(--solus-text-primary)" : "text-(--solus-text-tertiary)"}
              onclick={() => (chosenView = "steps")}>Steps</Button>
            <Button size="xs" variant="ghost" role="tab" aria-selected={isRawShown}
              class={isRawShown ? "bg-[var(--wash-2)] text-(--solus-text-primary)" : "text-(--solus-text-tertiary)"}
              onclick={() => (chosenView = "raw")}>Raw output</Button>
          </div>
          <Button size="icon-xs" variant="ghost" class="ml-auto" aria-label="Copy the build log" title="Copy the build log" disabled={!text} onclick={copyLog}><Copy /></Button>
        </div>
        <div bind:this={output} class="max-h-64 min-h-0 overflow-auto py-1.5">
          {#if truncated}
            <p class="text-chrome-dense px-3 pb-1 text-(--solus-text-tertiary)">Earlier output is not kept.</p>
          {/if}
          {#if !text}
            <p class="text-chrome-dense px-3 text-(--solus-text-tertiary)">{isActive ? "Waiting for output…" : "No output."}</p>
          {:else if isRawShown}
            <pre class="px-3 font-mono text-[0.6875rem] leading-relaxed break-all whitespace-pre-wrap text-(--solus-text-secondary)">{text}</pre>
          {:else}
            <ol class="text-chrome-dense">
              {#each steps as step, index (index)}
                <li class="flex min-w-0 items-start gap-2 px-3 py-0.5 {step.tone === 'error' ? 'text-[var(--failure)]' : step.tone === 'warning' ? 'text-[var(--warning)]' : index === steps.length - 1 && isActive ? 'text-(--solus-text-primary)' : 'text-(--solus-text-secondary)'}">
                  {#if step.tone === "error"}
                    <CircleX class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  {:else if step.tone === "warning"}
                    <TriangleAlert class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  {/if}
                  <span class="min-w-0 flex-1 {step.tone === 'step' ? 'truncate' : 'break-words'}">{step.text}</span>
                  {#if step.target}
                    <span class="max-w-[40%] shrink-0 truncate text-(--solus-text-tertiary)">{step.target}</span>
                  {/if}
                </li>
              {/each}
            </ol>
          {/if}
        </div>
      </div>
    {/if}
  </section>
{/if}
