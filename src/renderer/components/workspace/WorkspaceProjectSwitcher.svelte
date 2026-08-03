<script lang="ts">
  import { CaretDownIcon, SquaresFourIcon } from "phosphor-svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";
  import { abbreviateHome } from "../../lib/paths";

  /** The ledger's scope control: which open project the Workspace is showing.
   *  It sits at the top of the rail because every count below it — facets,
   *  saved views, the footer — is counted inside this scope. */
  interface Props {
    options: { key: string; label: string; count: number }[];
    /** null = all open projects. */
    value: string | null;
    allCount: number;
    onSelect: (key: string | null) => void;
    /** Set on the rail's copy only — the narrow-layout copy in the toolbar is
     *  the same control, and two test ids would be ambiguous. */
    testId?: string;
    /** Toolbar-sized, for the narrow layout where the rail is folded away. */
    compact?: boolean;
  }

  let { options, value, allCount, onSelect, testId, compact = false }: Props = $props();

  let menuOpen = $state(false);
  let triggerEl = $state<HTMLButtonElement | null>(null);

  const active = $derived(options.find((option) => option.key === value) ?? null);
</script>

<button
  type="button"
  bind:this={triggerEl}
  class="switcher-trigger"
  class:compact
  aria-label="Switch project"
  aria-haspopup="menu"
  aria-expanded={menuOpen}
  title="Switch project"
  data-testid={testId}
  onclick={() => (menuOpen = !menuOpen)}
>
  {#if active}
    {#key active.key}
      <ProjectFavicon projectRoot={active.key} />
    {/key}
  {:else}
    <SquaresFourIcon size={13} class="shrink-0 text-(--solus-text-tertiary)" />
  {/if}
  <span class="switcher-name">{active ? active.label : "All projects"}</span>
  <CaretDownIcon size={10} weight="bold" class="shrink-0 text-(--solus-text-tertiary)" />
</button>

<DropdownMenu.Root bind:open={menuOpen}>
  <DropdownMenu.Content
    customAnchor={triggerEl}
    side="bottom"
    align="start"
    sideOffset={6}
    class="w-[16.875rem]"
  >
    <!-- One-of-N pick, so a radio group: the shared menu row supplies the row
         metric, the label size, and the accent check in its trailing slot. The
         full path rides on the tooltip — project labels are already unique. -->
    <DropdownMenu.RadioGroup
      value={value ?? "all"}
      onValueChange={(key) => {
        menuOpen = false;
        onSelect(key === "all" ? null : key);
      }}
    >
      <DropdownMenu.GroupHeading>Projects</DropdownMenu.GroupHeading>
      {#each options as option (option.key)}
        <DropdownMenu.RadioItem value={option.key} title={abbreviateHome(option.key)}>
          <ProjectFavicon projectRoot={option.key} />
          <span class="min-w-0 flex-1 truncate">{option.label}</span>
          <span class="switcher-count">{option.count}</span>
        </DropdownMenu.RadioItem>
      {/each}
      {#if options.length > 1}
        <DropdownMenu.Separator />
        <DropdownMenu.RadioItem value="all">
          <SquaresFourIcon size={14} class="shrink-0" />
          <span class="min-w-0 flex-1 truncate">All projects</span>
          <span class="switcher-count">{allCount}</span>
        </DropdownMenu.RadioItem>
      {/if}
    </DropdownMenu.RadioGroup>
  </DropdownMenu.Content>
</DropdownMenu.Root>

<style>
  .switcher-trigger {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0.5625rem;
    padding: 0.375rem 0.4375rem;
    border: none;
    border-radius: 0.625rem;
    background: transparent;
    color: var(--solus-text-primary);
    text-align: left;
    cursor: pointer;
    transition: background 0.12s ease;
  }
  .switcher-trigger:hover {
    background: color-mix(in srgb, var(--solus-text-primary) 6%, transparent);
  }
  /* In the toolbar it is one control among several, so it drops to the row's
     own metric instead of the rail's title size. */
  .switcher-trigger.compact {
    height: 2.25rem;
    gap: 0.375rem;
    padding: 0 0.5rem;
    background: color-mix(in srgb, var(--muted) 62%, transparent);
    border-radius: 0.5625rem;
  }
  .switcher-name {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 1rem;
    font-weight: 640;
    letter-spacing: -0.028em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .switcher-trigger.compact .switcher-name {
    font-size: 0.7813rem;
    font-weight: 500;
    letter-spacing: 0;
  }
  .switcher-count {
    flex: 0 0 auto;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.625rem;
    font-variant-numeric: tabular-nums;
    color: var(--solus-text-tertiary);
    opacity: 0.62;
  }
</style>
