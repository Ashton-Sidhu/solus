<script lang="ts">
  import type { PaneEntry } from "../../contexts/workspace/routing/location";
  import { visibleRef } from "../../contexts/workspace/routing/location";
  import { ROUTES } from "../../contexts/workspace/routing/route-registry";
  import type { PaneSurfaceProps } from "./lib/pane-surface";
  import { getWorkspaceContext } from "../../contexts";
  // Eager, unlike every surface below: these are what cover an async boundary,
  // so they cannot sit behind one themselves.
  import ConversationPaneSkeleton from "../conversation/ConversationPaneSkeleton.svelte";
  import SettingsPageSkeleton from "../settings/SettingsPageSkeleton.svelte";

  /**
   * The route outlet: one pane, whatever route it currently shows. It knows
   * nothing about any destination — the registry says which module to load and
   * the surface owns its own chrome, so adding a destination touches no file
   * but the registry.
   */
  interface Props extends Omit<PaneSurfaceProps, "paneId"> {
    pane: PaneEntry;
  }

  let { pane, surfaceVisible = true, onAttachFile, onScreenshot, onDesignMode }: Props = $props();

  const session = getWorkspaceContext();
  const ref = $derived(visibleRef(pane));
  const descriptor = $derived(ref ? ROUTES[ref.name] : null);
  // Pages used to size themselves with `flex-1` as children of the content
  // column; a companion pane's wrapper is a block, so it needs the height.
  const isPage = $derived(descriptor?.exclusiveGroup === "page");
  const isLeading = $derived(session.router.leadingPane.id === pane.id);
</script>

{#snippet surface()}
  {#if ref && descriptor?.component}
    {#await descriptor.component()}
      {#if ref.name === "settings"}
        <SettingsPageSkeleton />
      {:else if ref.name === "chat"}
        <ConversationPaneSkeleton />
      {:else}
        <div
          class="grid h-full min-h-32 w-full place-items-center text-xs text-(--solus-text-tertiary)"
          role="status"
        >
          Loading…
        </div>
      {/if}
    {:then routeModule}
      {@const Surface = routeModule.default}
      <Surface
        params={ref.params}
        paneId={pane.id}
        {surfaceVisible}
        {onAttachFile}
        {onScreenshot}
        {onDesignMode}
      />
    {/await}
  {/if}
{/snippet}

{#if isPage}
  <div class="flex min-h-0 flex-col {isLeading ? 'flex-1' : 'h-full'}">
    {@render surface()}
  </div>
{:else}
  {@render surface()}
{/if}
