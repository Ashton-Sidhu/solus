<script lang="ts">
  import { getSettingsContext } from '../../contexts';
  import type { TaskViewFilters } from '@solus/contracts/task-views';
  import { putTaskSavedView } from '@solus/contracts/task-views';
  import { toasts } from '../../lib/toasts';
  import * as Popover from '../ui/popover';

  let {
    filters,
    onApply,
  }: { filters: TaskViewFilters; onApply: (filters: TaskViewFilters) => void } =
    $props();
  const settings = getSettingsContext();
  let name = $state('');
  let editingId = $state<string | null>(null);

  function save() {
    if (!name.trim()) return;
    const held = settings.taskSavedViews.find((view) => view.id === editingId);
    const next = putTaskSavedView(settings.taskSavedViews, {
      id: editingId ?? crypto.randomUUID(),
      name,
      filters: held?.filters ?? $state.snapshot(filters),
    });
    if (!settings.setPersonal('taskSavedViews', next)) {
      toasts.error('Could not save the task view');
      return;
    }
    name = '';
    editingId = null;
  }
</script>

<Popover.Root>
  <Popover.Trigger
    class="h-7 rounded-md px-2 text-workspace-chrome text-muted-foreground hover:bg-muted hover:text-foreground pointer-coarse:min-h-12"
    >Saved views</Popover.Trigger
  >
  <Popover.Content
    class="menu-surface z-[10002] w-72 rounded-xl bg-popover p-4 text-popover-foreground"
    align="end"
  >
    <div class="grid gap-2">
      {#each settings.taskSavedViews as view (view.id)}
        <div class="flex min-w-0 items-center gap-1">
          <button
            type="button"
            class="min-w-0 flex-1 truncate rounded-md p-2 text-left hover:bg-muted pointer-coarse:min-h-12"
            onclick={() => onApply(view.filters)}>{view.name}</button
          >
          <button
            type="button"
            class="rounded-md p-2 text-muted-foreground hover:bg-muted pointer-coarse:min-h-12"
            aria-label="Rename {view.name}"
            onclick={() => {
              editingId = view.id;
              name = view.name;
            }}>Rename</button
          >
          <button
            type="button"
            class="rounded-md p-2 text-muted-foreground hover:bg-muted pointer-coarse:min-h-12"
            aria-label="Remove {view.name}"
            onclick={() =>
              settings.setPersonal(
                'taskSavedViews',
                settings.taskSavedViews.filter((held) => held.id !== view.id),
              )}>Remove</button
          >
        </div>
      {:else}
        <p class="text-sm text-muted-foreground">
          Save these filters for another visit.
        </p>
      {/each}
      <form
        class="grid gap-2 border-t border-border pt-3"
        onsubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <label for="task-view-name" class="text-sm"
          >{editingId ? 'View name' : 'Save current view'}</label
        >
        <input
          id="task-view-name"
          name="task-view-name"
          bind:value={name}
          maxlength="100"
          class="min-w-0 rounded-md border border-input bg-transparent p-2"
        />
        <div class="flex gap-2">
          <button
            type="submit"
            disabled={!name.trim() ||
              (!editingId && settings.taskSavedViews.length >= 50)}
            class="rounded-md bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50"
            >Save</button
          >
          {#if editingId}<button
              type="button"
              class="rounded-md px-3 py-2 hover:bg-muted"
              onclick={() => {
                editingId = null;
                name = '';
              }}>Cancel</button
            >{/if}
        </div>
      </form>
    </div>
  </Popover.Content>
</Popover.Root>
