<script lang="ts">
  import { getSettingsContext } from '../../contexts';
  import type { PrViewFilters } from '@solus/contracts/pr-views';
  import { putPrSavedView } from '@solus/contracts/pr-views';
  import { toasts } from '../../lib/toasts';
  import * as Popover from '../ui/popover';

  let {
    filters,
    onApply,
  }: { filters: PrViewFilters; onApply: (filters: PrViewFilters) => void } =
    $props();
  const settings = getSettingsContext();
  let open = $state(false);
  let name = $state('');
  let editingId = $state<string | null>(null);

  function save() {
    if (!name.trim()) return;
    try {
      const held = settings.prSavedViews.find((view) => view.id === editingId);
      const next = putPrSavedView(settings.prSavedViews, {
        id: editingId ?? crypto.randomUUID(),
        name,
        filters: held?.filters ?? $state.snapshot(filters),
      });
      if (!settings.setPersonal('prSavedViews', next)) {
        toasts.error('Could not save the PR view');
        return;
      }
      name = '';
      editingId = null;
    } catch (error) {
      toasts.error('Could not save the PR view', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }
</script>

<Popover.Root bind:open>
  <Popover.Trigger
    class="h-7 rounded-md px-2 text-workspace-chrome text-muted-foreground hover:bg-muted hover:text-foreground pointer-coarse:min-h-12"
    >Saved views</Popover.Trigger
  >
  <Popover.Content
    class="menu-surface z-[10002] max-h-[min(32rem,var(--bits-popover-content-available-height))] w-72 overflow-y-auto rounded-xl bg-popover p-4 text-popover-foreground"
    align="end"
  >
    <div class="grid gap-2">
      {#each settings.prSavedViews as view (view.id)}
        <div class="flex min-w-0 items-center gap-1">
          <button
            type="button"
            class="min-w-0 flex-1 truncate rounded-md p-2 text-left hover:bg-muted pointer-coarse:min-h-12"
            onclick={() => {
              open = false;
              onApply(view.filters);
            }}>{view.name}</button
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
                'prSavedViews',
                settings.prSavedViews.filter((held) => held.id !== view.id),
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
        <label for="pr-view-name" class="text-sm"
          >{editingId ? 'View name' : 'Save current view'}</label
        >
        <input
          id="pr-view-name"
          name="pr-view-name"
          bind:value={name}
          maxlength="100"
          class="min-w-0 rounded-md border border-input bg-transparent p-2"
        />
        <div class="flex gap-2">
          <button
            type="submit"
            disabled={!name.trim() ||
              (!editingId && settings.prSavedViews.length >= 50)}
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
