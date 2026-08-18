<script lang="ts">
  import { CaretDownIcon, SquaresFourIcon, TrashIcon } from "phosphor-svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";
  import { abbreviateHome } from "../../lib/paths";

  /** One row this switcher can show — an open project (as today) or a
   *  catalog-only project the user has visited before but has nothing open in
   *  right now. Mirrors `ListProjectOption`'s shape without importing it —
   *  this is its own bespoke radio-group switcher, not the list-page one. */
  interface WorkspaceProjectOption {
    /** Unique across hosts — `hostKey(serverId, projectKey)`. */
    key: string;
    /** Repo root — the path the favicon and tooltip use. */
    projectKey: string;
    serverId: string;
    label: string;
    count: number;
    /** False when the option's host is disconnected — stays visible, dimmed,
     *  and cannot be selected. */
    available: boolean;
    /** True for a catalog-only entry with nothing open there right now — the
     *  only rows that offer "Remove from history". */
    historyOnly: boolean;
  }

  /** The ledger's scope control: which open or catalog project the Workspace
   *  is showing. It heads the page's action cluster, where Tasks and Pull
   *  requests keep theirs, and governs every facet count in the filter row
   *  below it. */
  interface Props {
    options: WorkspaceProjectOption[];
    /** The active option's `key`; null = all open projects. */
    value: string | null;
    allCount: number;
    onSelect: (option: WorkspaceProjectOption | null) => void;
    /** Forgets a catalog-only project. Files and sessions are untouched. */
    onRemoveHistory?: (option: WorkspaceProjectOption) => void;
  }

  let { options, value, allCount, onSelect, onRemoveHistory }: Props = $props();

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
      <ProjectFavicon projectRoot={active.projectKey} class="size-3.5" />
    {/key}
  {:else}
    <SquaresFourIcon size={14} class="shrink-0 text-muted-foreground" />
  {/if}
  <span class="min-w-0 flex-1 truncate text-sm font-normal ">
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
        onSelect(key === "all" ? null : (options.find((option) => option.key === key) ?? null));
      }}
    >
      <DropdownMenu.GroupHeading>Projects</DropdownMenu.GroupHeading>
      {#each options as option (option.key)}
        <div class="group/row flex items-center gap-0.5">
          <DropdownMenu.RadioItem
            value={option.key}
            title={option.available
              ? abbreviateHome(option.projectKey)
              : `${abbreviateHome(option.projectKey)} — host unavailable`}
            disabled={!option.available}
            class="min-w-0 flex-1 {option.available ? '' : 'opacity-50'}"
          >
            <ProjectFavicon projectRoot={option.projectKey} class="size-3.5" />
            <span class="min-w-0 flex-1 truncate">{option.label}</span>
            <span class="text-xs tabular-nums text-muted-foreground opacity-60">
              {option.count}
            </span>
          </DropdownMenu.RadioItem>
          {#if option.historyOnly && onRemoveHistory}
            <button
              type="button"
              class="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground opacity-0 transition-opacity duration-150 hover:bg-[var(--wash-2)] hover:text-foreground group-hover/row:opacity-100 pointer-coarse:opacity-100"
              title="Remove from history"
              aria-label="Remove {option.label} from history"
              onclick={() => onRemoveHistory(option)}
            >
              <TrashIcon size={13} />
            </button>
          {/if}
        </div>
      {/each}
      {#if options.length > 1}
        <DropdownMenu.Separator />
        <DropdownMenu.RadioItem value="all">
          <SquaresFourIcon size={14} class="shrink-0" />
          <span class="min-w-0 flex-1 truncate">All projects</span>
          <span class="text-xs tabular-nums text-muted-foreground opacity-60">
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
