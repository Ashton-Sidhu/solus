<script lang="ts">
  import { untrack } from "svelte";
  import type { AppStepView } from "@solus/contracts/apps";
  import { appsStore, type AppStepSourceQuery } from "../../../contexts/apps/apps.store.svelte";
  import StepCodeSheet from "./StepCodeSheet.svelte";
  import { prettyJson } from "./lib/activity";
  import { notRunText, stepCodeRefusal, stepPolicyLine, tryRows, type GraphStep } from "./lib/run-graph";

  /**
   * The step the graph selected, beside the canvas, plain on the page: where
   * it is in the run, how it tries again, each try with its outcome and time,
   * its error, and what to read next — the run's input, the step's result,
   * the run's log, and the code of the step in the version the run ran.
   */
  interface Props {
    serverId: string;
    appId: string;
    workflow: string;
    /** The version the run ran; null for the active version. */
    version: number | null;
    entry: GraphStep;
    /** 1-based place of the step among the steps of the graph. */
    position: number;
    count: number;
    /** The run's input as JSON text. */
    input: string;
    /** The newest good run's receipt of a step this run did not reach. */
    lastGood: AppStepView | null;
    now: number;
    onShowLog: () => void;
  }
  let { serverId, appId, workflow, version, entry, position, count, input, lastGood, now, onShowLog }: Props = $props();

  let shown = $state<"input" | "result" | null>(null);
  const step = $derived(entry.step);

  // The host finds where the step is in the source, so the Code button knows whether it can open it.
  const sourceQuery = $derived.by(() => {
    const query: AppStepSourceQuery = { workflow, step: entry.name };
    if (version !== null) query.version = version;
    return query;
  });
  $effect(() => {
    const hostId = serverId;
    const id = appId;
    const query = sourceQuery;
    return untrack(() => appsStore.stepSource.watch(hostId, id, query));
  });
  const isSourceForStep = $derived(JSON.stringify(appsStore.stepSource.queryFor(serverId, appId)) === JSON.stringify(sourceQuery));
  const source = $derived(isSourceForStep ? appsStore.stepSource.get(serverId, appId) : undefined);
  const sourceError = $derived(isSourceForStep ? appsStore.stepSource.errorFor(serverId, appId) : null);
  const codeRefusal = $derived(stepCodeRefusal(entry.name, version, source, sourceError));
  let showsCode = $state(false);
  let codeButton = $state<HTMLButtonElement | null>(null);

  function closeCode() {
    showsCode = false;
    codeButton?.focus();
  }
</script>

<aside class="flex w-65 shrink-0 flex-col gap-3.5 pt-1.5 pb-4.5 @max-[48rem]/pane:w-full" aria-label="Step {entry.name}" data-testid="app-step-inspector">
  <div class="flex min-w-0 flex-col gap-0.75">
    <span class="text-xs text-(--solus-text-tertiary)">Step {position} of {count}</span>
    <h3 class="m-0 truncate text-[17px] leading-5.5 font-semibold text-foreground" title={entry.name}>{entry.name}</h3>
    {#if step}
      <span class="text-[13px] text-(--solus-text-secondary)">{stepPolicyLine(step)}</span>
    {/if}
  </div>

  {#if step}
    <ul class="m-0 flex list-none flex-col p-0" aria-label="Tries">
      {#each tryRows(step, now) as row, index (index)}
        <li class="flex h-9 shrink-0 items-center justify-between gap-3 border-t border-[var(--hairline)] last:border-b">
          <span class="text-sm {row.isFinal ? 'font-medium text-(--failure)' : 'text-foreground'}">{row.label}</span>
          <span class="min-w-0 truncate text-[13px] tabular-nums {row.isFinal ? 'text-(--failure)' : 'text-(--solus-text-tertiary)'}">{row.detail}</span>
        </li>
      {/each}
    </ul>

    {#if step.error}
      <pre class="m-0 max-h-40 overflow-auto rounded-[10px] bg-[var(--wash-2)] px-3 py-2.5 font-mono text-xs leading-4.5 whitespace-pre-wrap text-(--solus-text-secondary)">{step.error}</pre>
    {/if}

    <div class="flex gap-2" role="group" aria-label="Read more">
      <button
        type="button"
        class="flex h-8 flex-1 cursor-pointer items-center justify-center rounded-full border border-[var(--hairline-strong)] bg-transparent text-[13px] text-foreground transition-colors duration-150 hover:bg-[var(--wash-1)] aria-pressed:bg-[var(--wash-3)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:h-11"
        aria-pressed={shown === "input"}
        onclick={() => (shown = shown === "input" ? null : "input")}>Input</button
      >
      <button
        type="button"
        class="flex h-8 flex-1 cursor-pointer items-center justify-center rounded-full border border-[var(--hairline-strong)] bg-transparent text-[13px] text-foreground transition-colors duration-150 hover:bg-[var(--wash-1)] aria-pressed:bg-[var(--wash-3)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] disabled:cursor-default disabled:opacity-40 pointer-coarse:h-11"
        aria-pressed={shown === "result"}
        disabled={step.result === null}
        title={step.result === null ? "The step has no result" : undefined}
        onclick={() => (shown = shown === "result" ? null : "result")}>Result</button
      >
      <button
        type="button"
        class="flex h-8 flex-1 cursor-pointer items-center justify-center rounded-full border border-[var(--hairline-strong)] bg-transparent text-[13px] text-foreground transition-colors duration-150 hover:bg-[var(--wash-1)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:h-11"
        onclick={onShowLog}>Log</button
      >
      <button
        bind:this={codeButton}
        type="button"
        class="flex h-8 flex-1 cursor-pointer items-center justify-center rounded-full border border-[var(--hairline-strong)] bg-transparent text-[13px] text-foreground transition-colors duration-150 hover:bg-[var(--wash-1)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] disabled:cursor-default disabled:opacity-40 pointer-coarse:h-11"
        disabled={codeRefusal !== null}
        title={codeRefusal ?? "Open the step's code, read-only"}
        aria-haspopup="dialog"
        onclick={() => (showsCode = true)}
        data-testid="app-step-code">Code</button
      >
    </div>
    <!-- A disabled button takes no focus, so the reason is also on the page once the host answered. -->
    {#if codeRefusal !== null && (source === null || sourceError !== null)}
      <span class="-mt-2 text-xs text-pretty text-(--solus-text-tertiary)">{codeRefusal}</span>
    {/if}

    {#if shown === "input"}
      <pre class="m-0 max-h-48 overflow-auto rounded-[10px] bg-[var(--wash-2)] px-3 py-2.5 font-mono text-xs whitespace-pre" aria-label="The run's input">{prettyJson(input)}</pre>
    {:else if shown === "result" && step.result !== null}
      <pre class="m-0 max-h-48 overflow-auto rounded-[10px] bg-[var(--wash-2)] px-3 py-2.5 font-mono text-xs whitespace-pre" aria-label="The step's result">{step.resultTruncated ? step.result : prettyJson(step.result)}</pre>
      {#if step.resultTruncated}
        <span class="-mt-2 text-xs text-(--solus-text-tertiary)">The start of the result.</span>
      {/if}
    {/if}
  {:else}
    <p class="m-0 text-[13px] text-pretty text-(--solus-text-secondary)">{notRunText(lastGood)}</p>
  {/if}
</aside>

{#if showsCode && source}
  <StepCodeSheet step={entry.name} {source} onClose={closeCode} />
{/if}
