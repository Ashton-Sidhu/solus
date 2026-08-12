<script lang="ts">
  import { CaretDownIcon, SquaresFourIcon } from "phosphor-svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";
  import { abbreviateHome } from "../../lib/paths";

  /** The ledger's scope control: which open project the Workspace is showing.
   *  It heads the page's action cluster, where Tasks and Pull requests keep
   *  theirs, and governs every facet count in the filter row below it. */
  interface Props {
    options: { key: string; label: string; count: number }[];
    /** null = all open projects. */
    value: string | null;
    allCount: number;
    onSelect: (key: string | null) => void;
  }

  let { options, value, allCount, onSelect }: Props = $props();

  let menuOpen = $state(false);
  let triggerEl = $state<HTMLButtonElement | null>(null);

  const active = $derived(options.find((option) => option.key === value) ?? null);
</script>

<button
  type="button"
  bind:this={triggerEl}
  class="relative flex h-[30px] max-w-[11rem] cursor-pointer items-center gap-[9px] rounded-md border-0 px-[9px] text-left transition-colors duration-150 hover:bg-[var(--wash-1)] {menuOpen
    ? 'bg-[var(--wash-2)]'
    : 'bg-transparent'}"
  aria-label="Switch project"
  aria-haspopup="menu"
  aria-expanded={menuOpen}
  title="Switch project"
  data-testid="workspace-project-switcher"
  onclick={() => (menuOpen = !menuOpen)}
>
  {#if active}
    {#key active.key}
      <ProjectFavicon projectRoot={active.key} class="size-3.5" />
    {/key}
  {:else}
    <SquaresFourIcon size={14} class="shrink-0 text-muted-foreground" />
  {/if}
  <span class="min-w-0 flex-1 truncate text-[0.8125rem] font-normal ">
    {active ? active.label : "All projects"}
  </span>
  <CaretDownIcon
    size={11}
    class="shrink-0 text-muted-foreground opacity-50 transition-transform duration-200 {menuOpen
      ? 'rotate-180'
      : ''}"
  />
</button>

<DropdownMenu.Root bind:open={menuOpen}>
  <DropdownMenu.Content
    customAnchor={triggerEl}
    side="bottom"
    align="start"
    sideOffset={5}
    class="w-[17.625rem]"
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
          <ProjectFavicon projectRoot={option.key} class="size-3.5" />
          <span class="min-w-0 flex-1 truncate">{option.label}</span>
          <span class="font-mono text-xs tabular-nums text-muted-foreground opacity-60">
            {option.count}
          </span>
        </DropdownMenu.RadioItem>
      {/each}
      {#if options.length > 1}
        <DropdownMenu.Separator />
        <DropdownMenu.RadioItem value="all">
          <SquaresFourIcon size={14} class="shrink-0" />
          <span class="min-w-0 flex-1 truncate">All projects</span>
          <span class="font-mono text-xs tabular-nums text-muted-foreground opacity-60">
            {allCount}
          </span>
        </DropdownMenu.RadioItem>
      {/if}
    </DropdownMenu.RadioGroup>

    <div
      class="mt-0.5 flex items-center border-t border-[var(--hairline)] px-[9px] pt-[7px] pb-1 text-xs text-muted-foreground"
    >
      Switching keeps facets, clears search
    </div>
  </DropdownMenu.Content>
</DropdownMenu.Root>
