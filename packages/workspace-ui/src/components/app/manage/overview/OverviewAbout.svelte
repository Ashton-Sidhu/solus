<script lang="ts">
  import type { AppSummary, AppUpdate } from "@solus/contracts/apps";
  import { APP_TILE_HUES, appMonogram, appTileHue } from "@solus/client-core/app-tile";
  import { appsStore } from "../../../../contexts/apps/apps.store.svelte";
  import { toasts } from "../../../../lib/toasts";
  import { Button } from "../../../ui/button";
  import { Input } from "../../../ui/input";
  import { Textarea } from "../../../ui/textarea";
  import AppTile from "../../AppTile.svelte";

  /**
   * About the app, plain on the page: its tile, the colour of the tile, its
   * description, and an edit of its name and description (docs/apps.md). The
   * host keeps them apart from the manifest, so a deploy does not undo them;
   * Reset goes back to the manifest's name or description.
   */
  interface Props {
    serverId: string;
    app: AppSummary;
  }
  let { serverId, app }: Props = $props();

  let isEditing = $state(false);
  // A draft follows the app until the owner types, and again after each save.
  let nameDraft = $derived(app.name);
  let descriptionDraft = $derived(app.description);
  let isSaving = $state(false);
  const automaticHue = $derived(appTileHue({ id: app.id, colorHue: null }));
  const monogram = $derived(appMonogram(app.name));

  async function save(patch: AppUpdate, failure: string) {
    isSaving = true;
    try {
      await appsStore.update(serverId, app.id, patch);
    } catch (error) {
      toasts.error(failure, { description: error instanceof Error ? error.message : String(error) });
    } finally {
      isSaving = false;
    }
  }

  function saveName() {
    const name = nameDraft.trim();
    if (name === app.name) return;
    // An empty name is no name of the owner's: the manifest's shows again.
    void save({ name: name || null }, "The app was not renamed");
  }

  function saveDescription() {
    if (descriptionDraft.trim() === app.description) return;
    void save({ description: descriptionDraft.trim() || null }, "The description was not saved");
  }
</script>

<!-- One colour: a small round swatch on that hue, with the app's tile beside the group to show the result. -->
{#snippet swatch(value: number | null, label: string, hue: number)}
  {@const isChosen = app.colorHue === value}
  <button
    type="button"
    role="radio"
    aria-checked={isChosen}
    aria-label={label}
    title={label}
    disabled={isSaving}
    class="size-4 shrink-0 cursor-pointer rounded-full border-0 p-0 bg-[oklch(0.62_0.09_var(--app-hue))] transition-shadow duration-150 focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] disabled:cursor-not-allowed dark:bg-[oklch(0.68_0.09_var(--app-hue))] {isChosen
      ? 'shadow-[0_0_0_2px_var(--background),0_0_0_3px_var(--foreground)]'
      : 'hover:shadow-[0_0_0_2px_var(--background),0_0_0_3px_var(--hairline-strongest)]'}"
    style:--app-hue={hue}
    onclick={() => {
      if (!isChosen) void save({ colorHue: value }, "The colour was not saved");
    }}
  ></button>
{/snippet}

<section class="flex min-w-0 flex-col gap-3" aria-label="About" data-testid="app-overview-about">
  <h3 class="m-0 text-[15px] font-semibold text-foreground">About</h3>
  <div class="flex items-center gap-3">
    <AppTile {monogram} hue={appTileHue(app)} size="md" />
    <div class="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Tile colour" data-testid="app-overview-colours">
      {@render swatch(null, "Automatic", automaticHue)}
      {#each APP_TILE_HUES as option (option.hue)}
        {@render swatch(option.hue, option.label, option.hue)}
      {/each}
    </div>
  </div>

  {#if isEditing}
    <div class="flex flex-col gap-2" data-testid="app-overview-rename">
      <Input
        class="text-sm"
        bind:value={nameDraft}
        maxlength={80}
        aria-label="App name"
        disabled={isSaving}
        onblur={saveName}
        onkeydown={(event: KeyboardEvent) => {
          if (event.key === "Enter") (event.currentTarget as HTMLInputElement).blur();
          if (event.key === "Escape") nameDraft = app.name;
        }}
        {@attach (element) => element.focus()}
      />
      <Textarea
        class="min-h-16 text-sm"
        bind:value={descriptionDraft}
        maxlength={1000}
        rows={3}
        aria-label="App description"
        placeholder="What does this app do?"
        disabled={isSaving}
        onblur={saveDescription}
      />
      <div class="flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="outline" class="text-workspace-chrome" disabled={isSaving} onclick={() => (isEditing = false)}>Done</Button>
        {#if app.name !== app.manifestName}
          <Button size="sm" variant="ghost" class="text-workspace-chrome text-muted-foreground" disabled={isSaving} onclick={() => save({ name: null }, "The name was not reset")}>Reset name</Button>
        {/if}
        {#if app.description !== app.manifestDescription}
          <Button size="sm" variant="ghost" class="text-workspace-chrome text-muted-foreground" disabled={isSaving} onclick={() => save({ description: null }, "The description was not reset")}>Reset description</Button>
        {/if}
      </div>
    </div>
  {:else}
    <p class="m-0 text-[13px] leading-[1.45] text-pretty {app.description ? 'text-(--solus-text-secondary)' : 'text-(--solus-text-tertiary)'}">
      {app.description || "No description."}
    </p>
    {#if app.name !== app.manifestName}
      <p class="m-0 text-[13px] text-(--solus-text-tertiary)">The app's own name is “{app.manifestName}”.</p>
    {/if}
    <button
      type="button"
      class="cursor-pointer self-start rounded border-0 bg-transparent p-0 text-[13px] text-(--solus-text-tertiary) underline decoration-[var(--hairline-strongest)] underline-offset-3 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
      onclick={() => (isEditing = true)}
      data-testid="app-overview-edit">Edit name and description</button
    >
  {/if}
</section>
