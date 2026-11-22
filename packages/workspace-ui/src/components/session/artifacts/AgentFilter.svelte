<script lang="ts">
  import { LoaderCircle as WorkingIcon, Check as DoneIcon } from "@lucide/svelte";
  import type { AgentScope } from "@solus/client-core/session-tree";
  import { steppedOption, type AgentFilterOption } from "./lib/agent-filter";

  /**
   * The agent filter (docs/plans/session-digests.md): All, This session, then
   * each session this one started. It narrows what is under it, as a turn of
   * the timeline does. A radio group: one chip is in the tab order, and Left
   * and Right step between them.
   */
  interface Props {
    options: readonly AgentFilterOption[];
    selected: AgentScope;
    onSelect: (scope: AgentScope) => void;
  }
  let { options, selected, onSelect }: Props = $props();

  let chips = $state<HTMLButtonElement[]>([]);

  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = steppedOption(options, selected, event.key === "ArrowLeft" ? -1 : 1);
    if (!next) return;
    onSelect(next.scope);
    chips[options.indexOf(next)]?.focus();
  }
</script>

<div
  role="radiogroup"
  aria-label="Show the work of"
  tabindex="-1"
  class="flex min-w-0 flex-wrap items-center gap-1"
  data-testid="agent-filter"
  onkeydown={handleKeydown}
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
      class="flex h-6 max-w-56 min-w-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-md border-0 px-2 text-xs transition-colors duration-(--duration-base) ease-(--ease-premium) focus-visible:outline-2 focus-visible:outline-(--solus-accent-border-medium) pointer-coarse:tap-area {on
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
