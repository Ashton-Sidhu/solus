<script lang="ts">
  /**
   * The part of each repository in a setup step, drawn as branches: each
   * repository forks off the step's rail, in the tone of its state. The one
   * that runs has the session sidebar's working dots where its time will go;
   * the one that failed has
   * an error note under it, and the host's output when the output belongs to it.
   */
  import type { StatusCardSubstep } from "@solus/contracts/types";
  import DotMatrix from "../ui/DotMatrix.svelte";
  import { TerminalOutput } from "../ui/terminal-output";
  import { liveActivityClock } from "../../lib/shared-clock";
  import { conversationIsVisible } from "./lib/conversation-visibility";
  import { showsStepDetail, substepElapsedNote, substepNote } from "./lib/status-card";

  interface Props {
    substeps: StatusCardSubstep[];
    /** The id of the sub-step that holds the host's output. */
    outputSubstepId?: string;
    /** The end of the host's output, for the sub-step that holds it. */
    output?: string;
  }

  let { substeps, outputSubstepId, output }: Props = $props();

  // A running repository's time ticks once a second, only while one runs and
  // the conversation is on screen.
  let now = $state(Date.now());
  const onScreen = conversationIsVisible();
  const hasRunning = $derived(substeps.some((substep) => substep.status === "active"));
  $effect(() => {
    if (!hasRunning || !onScreen()) return;
    return liveActivityClock.subscribe((value) => {
      now = value;
    });
  });
</script>

<!-- The list starts on the step's rail: 36px is the content column, 11px the
     rail's centre in the marker column. -->
<ul class="m-0 mt-1.5 -ml-[1.5625rem] flex list-none flex-col p-0" role="list">
  {#each substeps as substep (substep.id)}
    {@const note = substepNote(substep)}
    <li class="flex min-w-0 items-start">
      <svg
        width="20"
        height="32"
        viewBox="0 0 20 32"
        class="shrink-0 overflow-visible {substep.status === 'done'
          ? 'text-[color:color-mix(in_oklch,var(--solus-status-live)_45%,transparent)]'
          : substep.status === 'active'
            ? 'text-(--solus-text-primary)'
            : substep.status === 'error'
              ? 'text-[color:color-mix(in_oklch,var(--destructive)_45%,transparent)]'
              : substep.status === 'warning'
                ? 'text-[color:color-mix(in_oklch,var(--warning)_45%,transparent)]'
                : 'text-border'}"
        aria-hidden="true"
      >
        <path d="M0 0 V10 Q0 16 6 16 H20" fill="none" stroke="currentColor" stroke-width="1.25" />
      </svg>
      <div class="flex min-w-0 flex-1 flex-col pl-1.5">
        <div class="flex h-8 min-w-0 items-center gap-2.5">
          {#if substep.status === "done"}
            <span class="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-(--solus-status-live-bg)">
              <svg width="9" height="9" viewBox="0 0 24 24" role="img" aria-label="Done">
                <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="var(--solus-status-live)" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </span>
          {:else if substep.status === "active"}
            <!-- The repository in progress: a dark ring, as the current step has a dark number. -->
            <span class="size-4 shrink-0 rounded-full border-[1.5px] border-(--solus-text-primary)" aria-hidden="true"></span>
          {:else if substep.status === "error" || substep.status === "warning"}
            <span
              class="inline-flex size-4 shrink-0 items-center justify-center rounded-full {substep.status === 'error'
                ? 'bg-(--solus-status-error-bg) text-(--destructive)'
                : 'bg-[color:color-mix(in_oklch,var(--warning)_16%,transparent)] text-(--warning)'}"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" role="img" aria-label={substep.status === "error" ? "Failed" : "Warning"}>
                <path d="M12 5.5v8M12 18.5v.2" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" />
              </svg>
            </span>
          {:else}
            <span
              class="size-4 shrink-0 rounded-full border-[1.5px] border-border {substep.status === 'skipped' ? 'border-dashed' : ''}"
              role="img"
              aria-label={substep.status === "skipped" ? "Skipped" : "Waiting"}
            ></span>
          {/if}
          <span
            class="min-w-0 flex-1 truncate text-transcript-card {substep.status === 'active' || substep.status === 'error'
              ? 'font-semibold text-(--solus-text-primary)'
              : substep.status === 'done' || substep.status === 'warning'
                ? 'font-medium text-(--solus-text-secondary)'
                : 'font-medium text-(--solus-text-tertiary)'}">{substep.label}</span
          >
          {#if substep.status === "active"}
            <!-- The session sidebar's working mark, beside the time so far. -->
            {@const elapsed = substepElapsedNote(substep, now)}
            <span class="flex shrink-0 items-center gap-1.5">
              <span class="inline-flex size-4 items-center justify-center text-(--solus-status-working)">
                <DotMatrix mark="working" size={14} label="Running" />
              </span>
              {#if elapsed}<span class="text-transcript-meta text-(--solus-text-secondary) tabular-nums">{elapsed}</span>{/if}
            </span>
          {:else if note}
            <span class="shrink-0 text-transcript-meta text-(--solus-text-tertiary) tabular-nums">{note}</span>
          {/if}
        </div>
        {#if showsStepDetail(substep)}
          <!-- An error note, not a card: the line under the repository, in its tone. -->
          <p class="m-0 pb-2 pl-6.5 text-transcript-meta text-pretty {substep.status === 'error' ? 'text-destructive' : 'text-[color:color-mix(in_oklch,var(--warning)_70%,var(--foreground))]'}">
            {substep.detail}
          </p>
        {/if}
        {#if output && outputSubstepId === substep.id}
          <TerminalOutput {output} label="Setup output of {substep.label}" class="mb-2.5 ml-6.5 max-h-48" />
        {/if}
      </div>
    </li>
  {/each}
</ul>
