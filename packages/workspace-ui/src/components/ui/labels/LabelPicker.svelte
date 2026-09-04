<script lang="ts">
  import { Check as CheckIcon, Plus as PlusIcon } from "@lucide/svelte";
  import * as Command from "../command";
  import { MenuSearch } from "../menu";
  import * as Popover from "../popover";
  import LabelChip from "./LabelChip.svelte";
  import { labelTint } from "./label-color";
  import {
    canCreateLabel,
    labelPickerOptions,
    toggleLabelName,
    type LabelOption,
  } from "./label-picker";

  /** The label row every record draws: its chips, then a `+` that opens one
   *  searchable multi-select. A pull request hands in the host's labels with
   *  their colours; a task hands in names alone and may create one from the
   *  query. The picker owns the in-flight write, so a row cannot be toggled
   *  twice before the host has answered.
   *
   *  The menu is the same surface every other picker in the app opens — the
   *  task and provider pickers — so it reads as one control wherever it is. */
  let {
    labels,
    candidates,
    loading = false,
    loadFailed = false,
    allowCreate = false,
    align = "start",
    menuLabel,
    onOpen,
    onSet,
  }: {
    labels: LabelOption[];
    candidates: LabelOption[];
    /** The candidates are still being read; the menu says so. */
    loading?: boolean;
    loadFailed?: boolean;
    /** Offer "Create …" for a query no label matches. */
    allowCreate?: boolean;
    /** Which edge the chips and the menu hang from. */
    align?: "start" | "end";
    /** The menu's accessible name, e.g. "Edit task labels". */
    menuLabel: string;
    /** The menu opened; a lazy candidate read starts here. */
    onOpen?: () => void;
    /** Absent when the viewer may not edit: chips only, no `+`. */
    onSet?: (names: string[]) => Promise<void> | void;
  } = $props();

  let open = $state(false);
  let query = $state("");
  let mutation = $state(false);

  const selected = $derived(new Set(labels.map((label) => label.name.toLowerCase())));
  // The list is narrowed here, not by the command primitive: the "Create …"
  // row depends on the same query, and the two must agree on what matches.
  const options = $derived(labelPickerOptions(labels, candidates, query));
  const canCreate = $derived(allowCreate && canCreateLabel(labels, candidates, query));

  function handleOpenChange(next: boolean): void {
    open = next;
    if (next) onOpen?.();
    else query = "";
  }

  async function commit(names: string[]): Promise<void> {
    if (!onSet || mutation) return;
    mutation = true;
    try {
      await onSet(names);
    } finally {
      mutation = false;
    }
  }

  function toggle(name: string): void {
    const checked = !selected.has(name.toLowerCase());
    void commit(toggleLabelName(labels.map((label) => label.name), name, checked));
  }

  async function create(): Promise<void> {
    if (!canCreate || mutation) return;
    await commit(toggleLabelName(labels.map((label) => label.name), query, true));
    query = "";
  }
</script>

<div
  class="flex min-w-0 flex-1 flex-wrap items-center gap-1 {align === 'end' ? 'justify-end' : ''}"
>
  {#each labels as label (label.name)}
    <LabelChip label={label.name} color={label.color} />
  {/each}
  {#if onSet}
    <Popover.Root bind:open onOpenChange={handleOpenChange}>
      <Popover.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            type="button"
            class="grid size-5 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--wash-2)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] aria-expanded:bg-[var(--wash-2)] aria-expanded:text-foreground"
            aria-label={labels.length ? "Edit labels" : "Add a label"}
          >
            <PlusIcon size={12} />
          </button>
        {/snippet}
      </Popover.Trigger>
      <Popover.Content
        data-solus-ui
        side="bottom"
        {align}
        sideOffset={6}
        collisionPadding={8}
        class="menu-surface z-[10002] w-[min(15rem,calc(100vw-2rem))] gap-0 rounded-2xl bg-(--solus-menu-bg) p-0 text-workspace-chrome lg:text-workspace-chrome shadow-[shadow:var(--solus-menu-shadow)] ring-0 [&_.menu-row]:text-workspace-chrome [&_[data-slot=command-input]]:text-workspace-chrome pointer-fine:[.is-laptop-display_&]:w-[min(13rem,calc(100vw-2rem))]"
        aria-label={menuLabel}
      >
        <Command.Root shouldFilter={false}>
          <MenuSearch
            bind:value={query}
            placeholder={allowCreate ? "Search or create labels" : "Search labels"}
          />
          <!-- The list is the scrollport and the search field stays put above
               it: a name past the fold is reached by typing, so the field must
               never scroll away. The ceiling is measured against the window by
               the floating layer, less the search header. -->
          <Command.List
            class="max-h-[min(17.5rem,calc(var(--bits-popover-content-available-height,20rem)-3rem))] overflow-y-auto p-1.5"
          >
            {#if loading}
              <p class="px-2.5 py-2 text-xs text-(--solus-text-tertiary)">Loading labels…</p>
            {:else if loadFailed}
              <p class="px-2.5 py-2 text-xs text-(--solus-text-tertiary)">
                Couldn’t load labels
              </p>
            {:else}
              {#each options as option (option.name)}
                {@const current = selected.has(option.name.toLowerCase())}
                <Command.Item
                  value={option.name}
                  disabled={mutation}
                  onSelect={() => toggle(option.name)}
                  data-menu-current={current ? "" : undefined}
                  aria-checked={current}
                >
                  <span
                    class="size-2.5 shrink-0 rounded-full bg-[color-mix(in_oklch,var(--label-color)_42%,var(--background))] pointer-fine:[.is-laptop-display_&]:size-2"
                    style="--label-color: {labelTint(option.color)}"
                    aria-hidden="true"
                  ></span>
                  <span class="min-w-0 flex-1 truncate">{option.name}</span>
                  {#if current}
                    <CheckIcon size={12} class="shrink-0 text-(--solus-accent)" />
                  {/if}
                </Command.Item>
              {/each}
              {#if canCreate}
                <Command.Item
                  value="create {query.trim()}"
                  disabled={mutation}
                  onSelect={() => void create()}
                >
                  <PlusIcon size={13} class="shrink-0 text-(--solus-text-tertiary)" />
                  <span class="min-w-0 flex-1 truncate">Create “{query.trim()}”</span>
                </Command.Item>
              {:else if options.length === 0}
                <p class="px-2.5 py-3 text-center text-xs text-(--solus-text-tertiary)">
                  {query ? "No matching labels" : "No labels available"}
                </p>
              {/if}
            {/if}
          </Command.List>
        </Command.Root>
      </Popover.Content>
    </Popover.Root>
  {:else if labels.length === 0}
    <span class="text-muted-foreground">None</span>
  {/if}
</div>
