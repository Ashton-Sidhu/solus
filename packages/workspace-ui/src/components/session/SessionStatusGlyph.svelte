<script lang="ts">
  import { CircleDashed as IdleIcon } from "@lucide/svelte";
  import type { AttentionState, LiveMarkFacts } from "../../lib/sessionUtils";
  import { attentionLabel, getAttentionMark } from "../../lib/sessionUtils";
  import DotMatrix from "../ui/DotMatrix.svelte";

  interface Props {
    attention: AttentionState;
    /** The agent activity of a running turn, and whether the host is not
     *  reachable now. Without it a running session shows Working. */
    live?: LiveMarkFacts;
    class?: string;
  }
  let { attention, live = {}, class: className = "" }: Props = $props();

  const visual = $derived(
    getAttentionMark(attention, live) ?? {
      kind: "glyph" as const,
      component: IdleIcon,
      color: "var(--solus-text-tertiary)",
    },
  );
  const label = $derived(attentionLabel(attention, null, live) || "Idle");
  const Icon = $derived(visual.kind === "glyph" ? visual.component : null);
</script>

<span
  class="flex shrink-0 items-center {className}"
  style:color={visual.color}
  role="img"
  aria-label={label}
  title={label}
>
  {#if visual.kind === "dot"}
    <DotMatrix mark={visual.mark} size={14} />
  {:else if Icon}
    <Icon size={14} class="size-3.5" />
  {/if}
</span>
