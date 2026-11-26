<script lang="ts">
  import { tick } from 'svelte';
  import { Bookmark as BookmarkIcon, Pencil as PencilIcon, Trash2 as TrashIcon } from '@lucide/svelte';
  import { getSettingsContext } from '../../contexts';
  import type { TaskViewFilters } from '@solus/contracts/task-views';
  import { putTaskSavedView } from '@solus/contracts/task-views';
  import { toasts } from '../../lib/toasts';
  import * as DropdownMenu from '../ui/dropdown-menu';
  import { Button } from '../ui/button';
  import { Input } from '../ui/input';

  /** Saved views, as a submenu of the Filters menu. */
  let {
    filters,
    onApply,
  }: { filters: TaskViewFilters; onApply: (filters: TaskViewFilters) => void } =
    $props();
  const settings = getSettingsContext();
  let name = $state('');
  let editingId = $state<string | null>(null);
  let nameEl = $state<HTMLInputElement | null>(null);

  function save() {
    if (!name.trim()) return;
    const held = settings.taskSavedViews.find((view) => view.id === editingId);
    const next = putTaskSavedView(settings.taskSavedViews, {
      id: editingId ?? crypto.randomUUID(),
      name,
      filters: held?.filters ?? $state.snapshot(filters),
    });
    if (!settings.setPersonal('taskSavedViews', next)) {
      toasts.error('Could not save the issue view');
      return;
    }
    name = '';
    editingId = null;
  }

  async function rename(id: string, current: string) {
    editingId = id;
    name = current;
    await tick();
    nameEl?.focus();
    nameEl?.select();
  }
</script>

<DropdownMenu.Sub>
  <DropdownMenu.SubTrigger>
    <BookmarkIcon size={14} class="shrink-0 text-muted-foreground" />
    <span class="min-w-0 flex-1 truncate">Saved views</span>
    {#if settings.taskSavedViews.length > 0}
      <span class="tabular-nums text-muted-foreground">{settings.taskSavedViews.length}</span>
    {/if}
  </DropdownMenu.SubTrigger>
  <DropdownMenu.SubContent collisionPadding={8} class="flex max-h-[min(32rem,calc(var(--bits-dropdown-menu-content-available-height,36rem)-1rem))] w-72 max-w-[calc(100vw-1rem)] flex-col overflow-y-auto p-2">
    <div class="px-2 pt-0.5 pb-1.5 text-menu text-muted-foreground">Saved views</div>
    {#each settings.taskSavedViews as view (view.id)}
      <div class="flex min-w-0 items-center">
        <DropdownMenu.Item class="min-w-0 flex-1" onSelect={() => onApply(view.filters)}>
          <span class="min-w-0 flex-1 truncate">{view.name}</span>
        </DropdownMenu.Item>
        <DropdownMenu.Item closeOnSelect={false} aria-label="Rename {view.name}" title="Rename" onSelect={() => void rename(view.id, view.name)}>
          <PencilIcon size={14} class="text-muted-foreground" />
        </DropdownMenu.Item>
        <DropdownMenu.Item
          closeOnSelect={false}
          aria-label="Remove {view.name}"
          title="Remove"
          onSelect={() =>
            settings.setPersonal(
              'taskSavedViews',
              settings.taskSavedViews.filter((held) => held.id !== view.id),
            )}
        >
          <TrashIcon size={14} class="text-muted-foreground" />
        </DropdownMenu.Item>
      </div>
    {:else}
      <p class="px-2 py-1 text-menu text-muted-foreground">Save these filters for another visit.</p>
    {/each}
    <DropdownMenu.Separator />
    <form
      class="flex items-center gap-1.5 px-1 pt-1"
      onsubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <!-- The menu reads letters as typeahead and arrows as navigation;
           in the name field they belong to the text. Escape still closes. -->
      <Input
        bind:ref={nameEl}
        name="task-view-name"
        bind:value={name}
        maxlength={100}
        placeholder={editingId ? 'View name' : 'Save current view…'}
        aria-label={editingId ? 'View name' : 'Save current view'}
        onkeydown={(event) => {
          if (event.key !== 'Escape') event.stopPropagation();
        }}
        class="min-w-0 flex-1 text-menu pointer-coarse:h-12"
      />
      {#if editingId}
        <Button
          variant="ghost"
          class="text-menu text-muted-foreground pointer-coarse:h-12"
          onclick={() => {
            editingId = null;
            name = '';
          }}>Cancel</Button
        >
      {/if}
      <Button
        type="submit"
        disabled={!name.trim() ||
          (!editingId && settings.taskSavedViews.length >= 50)}
        class="text-menu pointer-coarse:h-12"
        >Save</Button
      >
    </form>
  </DropdownMenu.SubContent>
</DropdownMenu.Sub>
