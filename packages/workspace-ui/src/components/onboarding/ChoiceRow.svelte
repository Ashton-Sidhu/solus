<script lang="ts">
  /**
   * One option of a choice on the onboarding page: a radio and two lines, the
   * whole row the control. Arrow keys move between the options of a group
   * (`radioArrowKey`), and only the chosen one takes Tab.
   */
  import type { Snippet } from "svelte";

  interface Props {
    title: string;
    detail: string;
    isChosen: boolean;
    onchoose: () => void;
    trailing?: Snippet;
  }

  let { title, detail, isChosen, onchoose, trailing }: Props = $props();
</script>

<div class="flex items-start gap-3.5 py-3">
  <button
    type="button"
    role="radio"
    aria-checked={isChosen}
    tabindex={isChosen ? 0 : -1}
    class="group/choice flex min-w-0 flex-1 items-start gap-3.5 overflow-hidden rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    onclick={onchoose}
  >
    <span
      class="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px] group-hover/choice:border-(--solus-text-secondary)"
      class:border-(--solus-text-primary)={isChosen}
      class:border-border={!isChosen}
      aria-hidden="true"
    >
      {#if isChosen}<span class="size-2 rounded-full bg-(--solus-text-primary)"></span>{/if}
    </span>
    <span class="flex min-w-0 flex-1 flex-col gap-0.75">
      <span class="text-[14px] leading-5 font-medium text-(--solus-text-primary)">{title}</span>
      <span class="text-[13px] leading-4.75 text-(--solus-text-tertiary)">{detail}</span>
    </span>
  </button>
  {#if trailing}<div class="flex w-30 shrink-0 justify-end">{@render trailing()}</div>{/if}
</div>
