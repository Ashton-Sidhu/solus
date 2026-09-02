<script lang="ts">
  import { CircleDashed as IdleIcon } from "@lucide/svelte";
  import type { AttentionState } from "../../lib/sessionUtils";
  import { attentionLabel, getAttentionIcon } from "../../lib/sessionUtils";

  interface Props {
    attention: AttentionState;
    class?: string;
  }
  let { attention, class: className = "" }: Props = $props();

  const visual = $derived(
    getAttentionIcon(attention) ?? {
      component: IdleIcon,
      color: "var(--solus-text-tertiary)",
      spin: false,
    },
  );
  const label = $derived(attentionLabel(attention) || "Idle");
  const Icon = $derived(visual.component);
</script>

<span
  class="flex shrink-0 items-center {className}"
  style:color={visual.color}
  role="img"
  aria-label={label}
  title={label}
>
  <Icon
    size={14}
    class="size-3.5 md:pointer-fine:[.is-laptop-display_&]:size-3 {visual.spin
      ? 'animate-spin motion-reduce:animate-none'
      : ''}"
  />
</span>
