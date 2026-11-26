<script lang="ts">
  import {
    Bookmark as BookmarkIcon,
    Pencil as PencilIcon,
    Plus as PlusIcon,
    Trash2 as TrashIcon,
  } from "@lucide/svelte";
  import { getSettingsContext } from "../../contexts";
  import type { PrViewFilters } from "@solus/contracts/pr-views";
  import { putPrSavedView } from "@solus/contracts/pr-views";
  import { toasts } from "../../lib/toasts";
  import * as DropdownMenu from "../ui/dropdown-menu";

  /** Saved views, as one group of the Filters menu: each view applies its
   *  search, filters and sort; the field at the end saves the current ones
   *  under a name, or renames a view. The same choices as the mobile app's
   *  saved views menu. */
  let {
    filters,
    onApply,
  }: { filters: PrViewFilters; onApply: (filters: PrViewFilters) => void } =
    $props();
  const settings = getSettingsContext();
  const MAX_VIEWS = 50;
  let name = $state("");
  let editingId = $state<string | null>(null);
  const editing = $derived(settings.prSavedViews.find((view) => view.id === editingId) ?? null);
  const canSave = $derived(!!name.trim() && (!!editing || settings.prSavedViews.length < MAX_VIEWS));

  function save(): void {
    if (!canSave) return;
    try {
      const next = putPrSavedView(settings.prSavedViews, {
        id: editing?.id ?? crypto.randomUUID(),
        name,
        filters: editing?.filters ?? $state.snapshot(filters),
      });
      if (!settings.setPersonal("prSavedViews", next)) {
        toasts.error("Could not save the PR view");
        return;
      }
      name = "";
      editingId = null;
    } catch (error) {
      toasts.error("Could not save the PR view", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function remove(id: string): void {
    if (editingId === id) {
      editingId = null;
      name = "";
    }
    settings.setPersonal("prSavedViews", settings.prSavedViews.filter((view) => view.id !== id));
  }
</script>

<DropdownMenu.Sub>
  <DropdownMenu.SubTrigger>
    <BookmarkIcon size={14} class="shrink-0 text-muted-foreground" />
    <span class="min-w-0 flex-1 truncate">Saved views</span>
    {#if settings.prSavedViews.length > 0}
      <span class="text-muted-foreground tabular-nums">{settings.prSavedViews.length}</span>
    {/if}
  </DropdownMenu.SubTrigger>
  <DropdownMenu.SubContent
    class="flex max-h-[min(28rem,calc(var(--bits-dropdown-menu-content-available-height,36rem)-1rem))] w-72 flex-col overflow-hidden p-2"
  >
    <DropdownMenu.Label>Saved views</DropdownMenu.Label>
    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {#each settings.prSavedViews as view (view.id)}
        <div class="group/view-row relative">
          <DropdownMenu.Item class="pr-16 pointer-coarse:pr-20" onSelect={() => onApply(view.filters)}>
            <span class="min-w-0 flex-1 truncate">{view.name}</span>
          </DropdownMenu.Item>
          <!-- Beside the row, not inside it: a menu item holds no other control. -->
          <span
            class="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5 opacity-0 group-hover/view-row:opacity-100 group-focus-within/view-row:opacity-100 pointer-coarse:opacity-100"
          >
            <button
              type="button"
              class="grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-(--solus-surface-hover) hover:text-foreground focus-visible:outline-2 focus-visible:outline-(--solus-accent) pointer-coarse:size-9"
              title="Rename"
              aria-label="Rename {view.name}"
              onclick={() => {
                editingId = view.id;
                name = view.name;
              }}
            >
              <PencilIcon size={13} />
            </button>
            <button
              type="button"
              class="grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-(--solus-surface-hover) hover:text-foreground focus-visible:outline-2 focus-visible:outline-(--solus-accent) pointer-coarse:size-9"
              title="Delete"
              aria-label="Delete {view.name}"
              onclick={() => remove(view.id)}
            >
              <TrashIcon size={13} />
            </button>
          </span>
        </div>
      {:else}
        <div class="px-2 py-1.5 text-menu text-muted-foreground">Save the current search, filters and sort to use them again.</div>
      {/each}
    </div>
    <DropdownMenu.Separator />
    <form
      class="flex h-9 shrink-0 items-center gap-2 px-2"
      onsubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <span class="grid size-5 shrink-0 place-items-center text-muted-foreground">
        {#if editing}<PencilIcon size={14} />{:else}<PlusIcon size={15} />{/if}
      </span>
      <input
        bind:value={name}
        type="text"
        name="pr-view-name"
        maxlength="100"
        placeholder={editing ? `Rename “${editing.name}”` : settings.prSavedViews.length >= MAX_VIEWS ? "50 views saved" : "Save current view as…"}
        aria-label={editing ? `Rename ${editing.name}` : "Name for the current view"}
        disabled={!editing && settings.prSavedViews.length >= MAX_VIEWS}
        class="min-w-0 flex-1 border-0 bg-transparent text-menu text-foreground caret-[var(--primary)] outline-none placeholder:text-muted-foreground"
        onkeydown={(event) => {
          if (event.key === "Escape" && editing) {
            event.preventDefault();
            editingId = null;
            name = "";
          }
          // The menu's typeahead would otherwise move focus to a matching row.
          if (event.key !== "Escape" || editing) event.stopPropagation();
        }}
      />
      {#if name.trim()}
        <button
          type="submit"
          disabled={!canSave}
          class="shrink-0 cursor-pointer rounded-md px-1.5 py-0.5 text-xs font-medium text-(--solus-accent) hover:bg-(--solus-surface-hover) disabled:opacity-50"
        >
          {editing ? "Rename" : "Save"}
        </button>
      {/if}
    </form>
  </DropdownMenu.SubContent>
</DropdownMenu.Sub>
