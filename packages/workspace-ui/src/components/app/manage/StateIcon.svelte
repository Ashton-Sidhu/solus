<script lang="ts">
  import {
    Circle as IdleIcon,
    CircleCheck as OkIcon,
    CircleDashed as RunningIcon,
    CirclePause as PausedIcon,
    CircleSlash as StoppedIcon,
    CircleX as FailedIcon,
    Moon as SleepingIcon,
    TriangleAlert as WarningIcon,
  } from "@lucide/svelte";
  import type { ManageState } from "./lib/states";

  /**
   * The one mark for how a thing of the Manage page stands: a call, a run, a
   * step, a version, a delivery. The shape says the state, so the colour is
   * not the only signal. With a `label` it is read aloud; without one the text
   * beside it says the state.
   */
  interface Props {
    state: ManageState;
    label?: string;
    size?: number;
    class?: string;
  }
  let { state, label, size = 16, class: className = "" }: Props = $props();
</script>

{#if state === "ok"}
  <OkIcon {size} strokeWidth={1.75} class="shrink-0 text-(--success) {className}" aria-label={label} aria-hidden={label ? undefined : "true"} />
{:else if state === "failed"}
  <FailedIcon {size} strokeWidth={1.75} class="shrink-0 text-(--failure) {className}" aria-label={label} aria-hidden={label ? undefined : "true"} />
{:else if state === "running"}
  <RunningIcon {size} strokeWidth={1.75} class="shrink-0 text-(--solus-status-running) {className}" aria-label={label} aria-hidden={label ? undefined : "true"} />
{:else if state === "sleeping"}
  <SleepingIcon {size} strokeWidth={1.75} class="shrink-0 text-muted-foreground {className}" aria-label={label} aria-hidden={label ? undefined : "true"} />
{:else if state === "paused"}
  <PausedIcon {size} strokeWidth={1.75} class="shrink-0 text-muted-foreground {className}" aria-label={label} aria-hidden={label ? undefined : "true"} />
{:else if state === "stopped"}
  <StoppedIcon {size} strokeWidth={1.75} class="shrink-0 text-muted-foreground {className}" aria-label={label} aria-hidden={label ? undefined : "true"} />
{:else if state === "warning"}
  <WarningIcon {size} strokeWidth={1.75} class="shrink-0 text-(--warning) {className}" aria-label={label} aria-hidden={label ? undefined : "true"} />
{:else}
  <IdleIcon {size} strokeWidth={1.75} class="shrink-0 text-muted-foreground/70 {className}" aria-label={label} aria-hidden={label ? undefined : "true"} />
{/if}
