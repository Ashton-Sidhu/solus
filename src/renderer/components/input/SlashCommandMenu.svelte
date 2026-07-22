<script lang="ts">
  import type {
    SlashCommand,
    CategorizedSlashCommands,
  } from "./slash-commands";
  import { fly } from "svelte/transition";
  import { getPopoverLayer } from "../popoverLayer.svelte";
  import { portal } from "../portal";

  interface Props {
    filter: string;
    selectedIndex: number;
    onSelect: (cmd: SlashCommand) => void;
    anchorRect: DOMRect | null;
    commands: CategorizedSlashCommands;
    /** Whether the menu grows upward (above the cursor) or downward. */
    placement?: "up" | "down";
  }

  let { filter, selectedIndex, onSelect, anchorRect, commands, placement = "up" }: Props =
    $props();

  const layer = getPopoverLayer();

  const q = $derived(filter.toLowerCase());
  const pass = $derived((c: SlashCommand) => c.command.startsWith(q));
  const solusFiltered = $derived(commands.solus.filter(pass));
  const ccFiltered = $derived(commands.claudeCode.filter(pass));
  const globalFiltered = $derived(commands.global.filter(pass));
  const projectFiltered = $derived(commands.project.filter(pass));
  const totalCount = $derived(
    solusFiltered.length +
      ccFiltered.length +
      globalFiltered.length +
      projectFiltered.length,
  );

  let listEl: HTMLDivElement | null = $state(null);

  $effect(() => {
    if (!listEl) return;
    const buttons = listEl.querySelectorAll("button");
    const btn = buttons[selectedIndex] as HTMLElement | undefined;
    btn?.scrollIntoView({ block: "nearest" });
  });

  const scrollThumb = `color-mix(in srgb, var(--solus-text-tertiary) 40%, transparent)`;
</script>

{#if totalCount > 0 && anchorRect && layer.el}
  <div
    use:portal={layer.el}
    transition:fly={{ y: placement === "down" ? 3 : -3, duration: 80 }}
    style="position:fixed;pointer-events:auto;{placement === 'down'
      ? `top:${anchorRect.bottom + 4}px`
      : `bottom:${window.innerHeight - anchorRect.top + 4}px`};left:{anchorRect.left +
      12}px;right:{window.innerWidth - anchorRect.right + 12}px"
  >
    <div
      bind:this={listEl}
      class="overflow-y-auto rounded-xl border border-(--solus-popover-border) bg-(--solus-popover-bg) py-0.5 [&::-webkit-scrollbar]:w-[0.1875rem] [&::-webkit-scrollbar-thumb]:rounded [&::-webkit-scrollbar-thumb]:bg-(--scroll-thumb) [&::-webkit-scrollbar-track]:bg-transparent"
      style="max-height:12.25rem;backdrop-filter:blur(1.25rem);box-shadow:var(--solus-popover-shadow);--scroll-thumb:{scrollThumb}"
    >
      {@render commandSection(null, solusFiltered, 0)}
      {@render commandSection("Claude Code", ccFiltered, solusFiltered.length)}
      {@render commandSection(
        "Global",
        globalFiltered,
        solusFiltered.length + ccFiltered.length,
      )}
      {@render commandSection(
        "Project",
        projectFiltered,
        solusFiltered.length + ccFiltered.length + globalFiltered.length,
      )}
    </div>
  </div>
{/if}

{#snippet commandSection(
  title: string | null,
  items: SlashCommand[],
  offset: number,
)}
  {#if items.length > 0}
    {#if title}
      <div
        class="px-3 pt-2 pb-0.5 text-[0.625rem] uppercase tracking-wider text-(--solus-text-tertiary)"
      >
        {title}
      </div>
    {/if}
    {#each items as cmd, i (cmd.command)}
      {@render commandButton(cmd, offset + i === selectedIndex)}
    {/each}
  {/if}
{/snippet}

{#snippet commandButton(cmd: SlashCommand, isSelected: boolean)}
  <button
    onclick={() => onSelect(cmd)}
    class="w-full flex items-center gap-2 px-3 py-[0.3125rem] text-left hover:bg-(--solus-surface-hover)"
    style="background:{isSelected
      ? 'var(--solus-accent-light)'
      : 'transparent'};box-shadow:{isSelected
      ? 'inset 0.125rem 0 0 var(--solus-accent)'
      : 'none'}"
  >
    <span
      class="flex-shrink-0 flex items-center {isSelected
        ? 'text-(--solus-accent)'
        : 'text-(--solus-text-tertiary)'}"
    >
      {#if cmd.iconComponent}
        {@const Comp = cmd.iconComponent}
        <Comp size={12} />
      {:else if cmd.iconText}
        <span class="text-[0.6875rem] font-mono">{cmd.iconText}</span>
      {:else}
        <span class="text-[0.6875rem] font-mono">/</span>
      {/if}
    </span>
    <div class="min-w-0 flex-1 flex items-baseline gap-1.5 overflow-hidden">
      <span
        class="text-[0.75rem] font-mono font-medium shrink-0 {isSelected
          ? 'text-(--solus-accent)'
          : 'text-(--solus-text-primary)'}"
      >
        {cmd.command}
      </span>
      <span
        class="text-[0.625rem] font-mono truncate text-(--solus-text-tertiary)"
      >
        {cmd.description}
      </span>
    </div>
  </button>
{/snippet}
