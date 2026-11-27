<script lang="ts">
  import { CircleCheck as OkIcon, CircleDashed as IdleIcon, CircleX as FailedIcon, Clock as WarningIcon } from "@lucide/svelte";
  import DotMatrix from "../../ui/DotMatrix.svelte";
  import { DOT_MATRIX_BOX_PX } from "../../ui/lib/dot-matrix";
  import type { ManageState } from "./lib/states";

  /**
   * The one mark for how a thing of the Manage page stands: an app, a call, a
   * run, a step, a version, a delivery. It draws the session marks
   * (`SessionStatusGlyph`, `getAttentionMark`), so a reader learns one set of
   * marks for sessions and apps. A state is never a word beside the mark: with
   * a `label` it is read aloud and shown on hover; without one the text beside
   * it says the state.
   */
  interface Props {
    state: ManageState;
    label?: string;
    /** The box of the mark, in px. A dot mark fills it as a 16px line glyph does. */
    size?: number;
    class?: string;
  }
  let { state, label, size = 16, class: className = "" }: Props = $props();

  /** The grid of a dot mark is the drawn circle of a line glyph: 13px in a 16px box. */
  const dotBox = $derived((size * DOT_MATRIX_BOX_PX) / 16);
</script>

<span
  class="inline-flex shrink-0 items-center justify-center {state === 'running' || state === 'starting'
    ? 'text-(--solus-status-working)'
    : state === 'offline'
      ? 'text-muted-foreground'
      : state === 'ok'
        ? 'text-(--solus-status-complete)'
        : state === 'failed'
          ? 'text-(--destructive)'
          : state === 'warning'
            ? 'text-(--warning)'
            : 'text-(--solus-text-tertiary)'} {className}"
  style:width="{size}px"
  style:height="{size}px"
  role={label ? "img" : undefined}
  aria-label={label}
  aria-hidden={label ? undefined : "true"}
  title={label}
  data-state={state}
>
  {#if state === "running"}
    <DotMatrix mark="working" size={dotBox} />
  {:else if state === "starting"}
    <DotMatrix mark="starting" size={dotBox} />
  {:else if state === "offline"}
    <DotMatrix mark="offline" size={dotBox} />
  {:else if state === "ok"}
    <OkIcon {size} strokeWidth={2.25} />
  {:else if state === "failed"}
    <FailedIcon {size} strokeWidth={2.25} />
  {:else if state === "warning"}
    <WarningIcon {size} strokeWidth={2.25} />
  {:else}
    <IdleIcon {size} strokeWidth={2.25} />
  {/if}
</span>
