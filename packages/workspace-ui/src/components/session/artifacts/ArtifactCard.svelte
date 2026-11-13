<script lang="ts">
  import type { Component, Snippet } from "svelte";
  import { ChevronDown as CaretIcon } from "@lucide/svelte";

  /**
   * One kind of thing the session has, as a floating card
   * (docs/plans/session-artifacts.md): the transcript card's shell, a quiet
   * label, and the rows. The label closes the card and the body eases shut.
   * A closed card keeps its count and its summary, so it still answers "how
   * many, and how do they stand".
   */
  interface Props {
    icon: Component<{ size?: number; strokeWidth?: number; class?: string }>;
    title: string;
    count: number;
    /** The label's trailing reading: line totals, how many agents run. */
    summary?: Snippet;
    children: Snippet;
  }
  let { icon: Icon, title, count, summary, children }: Props = $props();

  let open = $state(true);
</script>

<section
  aria-label={title}
  class="@container/card mb-2.5 break-inside-avoid rounded-2xl bg-(--solus-tx-card-bg) p-1.5 shadow-[shadow:var(--solus-tx-card-shadow)]"
  data-testid="artifacts-card"
>
  <h3 class="m-0 font-normal">
    <button
      type="button"
      aria-expanded={open}
      class="group/head flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 overflow-hidden rounded-lg border-0 bg-transparent px-2 text-left text-muted-foreground transition-colors duration-(--duration-base) ease-(--ease-premium) hover:text-foreground focus-visible:outline-2 focus-visible:outline-(--solus-accent-border-medium) pointer-coarse:h-11"
      onclick={() => (open = !open)}
    >
      <Icon size={14} strokeWidth={1.75} class="shrink-0" />
      <span class="min-w-0 truncate text-xs font-medium tracking-[0.04em] uppercase">{title}</span>
      <span class="shrink-0 text-xs tabular-nums opacity-60">{count}</span>
      <!-- Beside the label, not at the row's end: the summary's numbers then end where the rows' numbers end. -->
      <CaretIcon
        size={14}
        class="shrink-0 transition-[transform,opacity] duration-300 ease-(--ease-premium) group-hover/head:opacity-100 group-focus-visible/head:opacity-100 motion-reduce:transition-none pointer-coarse:opacity-100 {open
          ? 'opacity-0'
          : '-rotate-90 opacity-100'}"
      />
      <span class="flex-1"></span>
      {@render summary?.()}
    </button>
  </h3>
  <!-- Closed, the rows stay mounted and leave the tab order when the body has shut. -->
  <div
    class="grid transition-[grid-template-rows] duration-[380ms] ease-(--ease-premium) motion-reduce:transition-none {open
      ? 'grid-rows-[1fr]'
      : 'grid-rows-[0fr]'}"
  >
    <div class="min-h-0 overflow-hidden {open ? '' : 'invisible [transition:visibility_0s_380ms]'}">
      <div class="flex flex-col gap-px pt-0.5">
        {@render children()}
      </div>
    </div>
  </div>
</section>
