<script lang="ts">
  import { ChevronLeft as PreviousIcon, ChevronRight as NextIcon, LoaderCircle as WorkingIcon, Check as DoneIcon } from "@lucide/svelte";
  import type { AgentScope } from "@solus/client-core/session-tree";
  import { Button } from "../../ui/button";
  import { steppedOption, type AgentFilterOption } from "./lib/agent-filter";

  /**
   * The agent filter (docs/plans/session-digests.md): All, This session, then
   * each session this one started. It narrows what is under it, as a turn of
   * the timeline does. A radio group on one line: it scrolls sideways, and the
   * carets page through it when it is wider than the pane. One chip is in the
   * tab order, and Left and Right step between them.
   */
  interface Props {
    options: readonly AgentFilterOption[];
    selected: AgentScope;
    onSelect: (scope: AgentScope) => void;
  }
  let { options, selected, onSelect }: Props = $props();

  let chips = $state<HTMLButtonElement[]>([]);
  let scroller = $state<HTMLDivElement | null>(null);
  let canScrollBack = $state(false);
  let canScrollOn = $state(false);

  function measure() {
    if (!scroller) return;
    canScrollBack = scroller.scrollLeft > 1;
    canScrollOn = scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1;
  }

  // The carets follow the row's width and its chips: a pane resize or a new started session changes both.
  $effect(() => {
    if (!scroller) return;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    for (const chip of chips) if (chip) observer.observe(chip);
    return () => observer.disconnect();
  });

  /** A page is most of the visible row, so the chip cut at its edge stays in view. */
  function page(direction: -1 | 1) {
    if (!scroller) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scroller.scrollBy({ left: direction * scroller.clientWidth * 0.8, behavior: reduceMotion ? "auto" : "smooth" });
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = steppedOption(options, selected, event.key === "ArrowLeft" ? -1 : 1);
    if (!next) return;
    onSelect(next.scope);
    const chip = chips[options.indexOf(next)];
    chip?.focus();
    chip?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
</script>

<div class="flex min-w-0 items-center gap-1">
  <!-- Room around each chip for its focus outline, which the scroller would otherwise clip. -->
  <div
    bind:this={scroller}
    role="radiogroup"
    aria-label="Show the work of"
    tabindex="-1"
    class="-m-0.5 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden overscroll-x-contain p-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:h-0"
    data-testid="agent-filter"
    onkeydown={handleKeydown}
    onscroll={measure}
  >
    {#each options as option, index (option.scope)}
      {@const on = selected === option.scope}
      <button
        bind:this={chips[index]}
        type="button"
        role="radio"
        aria-checked={on}
        tabindex={on ? 0 : -1}
        title={option.isRemote ? `${option.label}, on another host` : option.label}
        class="flex h-6 max-w-56 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-md border-0 px-2 text-xs transition-colors duration-(--duration-base) ease-(--ease-premium) focus-visible:outline-2 focus-visible:outline-(--solus-accent-border-medium) pointer-coarse:tap-area {on
          ? 'bg-[color-mix(in_oklab,var(--solus-art-5)_11%,transparent)] text-[color-mix(in_oklab,var(--solus-art-5)_78%,var(--foreground))] shadow-[inset_0_0_0_.5px_color-mix(in_oklab,var(--solus-art-5)_38%,transparent)]'
          : 'bg-transparent text-(--solus-text-secondary) shadow-[inset_0_0_0_.5px_var(--hairline-strong)] hover:bg-[var(--wash-2)]'}"
        data-testid="agent-filter-option"
        onclick={() => onSelect(option.scope)}
      >
        {#if option.state === "running"}
          <WorkingIcon size={12} class="shrink-0 animate-spin text-(--solus-status-running-icon) motion-reduce:animate-none" />
        {:else if option.state === "done"}
          <DoneIcon size={12} class="shrink-0 text-(--solus-status-complete)" />
        {/if}
        <span class="truncate">{option.label}</span>
        {#if option.isRemote}<span class="shrink-0 opacity-60">· remote</span>{/if}
      </button>
    {/each}
  </div>
  <!-- The carets show only when the row is wider than the pane. -->
  {#if canScrollBack || canScrollOn}
    <div class="flex shrink-0 gap-0.5 pr-0.5">
      <Button variant="ghost" size="icon-xs" class="text-muted-foreground pointer-coarse:tap-area" aria-label="Earlier sessions" title="Earlier sessions" disabled={!canScrollBack} data-testid="agent-filter-previous" onclick={() => page(-1)}>
        <PreviousIcon />
      </Button>
      <Button variant="ghost" size="icon-xs" class="text-muted-foreground pointer-coarse:tap-area" aria-label="Later sessions" title="Later sessions" disabled={!canScrollOn} data-testid="agent-filter-next" onclick={() => page(1)}>
        <NextIcon />
      </Button>
    </div>
  {/if}
</div>
