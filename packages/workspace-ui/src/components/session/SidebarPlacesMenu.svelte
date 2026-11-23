<script lang="ts">
  import { Activity as ActivityIcon, LibraryBig as LibraryIcon, Workflow as WorkflowIcon } from "@lucide/svelte";
  import { appsStore } from "../../contexts/apps/apps.store.svelte";
  import { getSettingsContext, serversStore } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import {
    appPinOf,
    isAppPinned,
    isPlaceShown,
    isPlacesLayoutChanged,
    orderedPlaces,
    withAppMoved,
    withAppPinned,
    withPlaceMoved,
    withPlaceShown,
    type SidebarPlacesMenuTarget,
  } from "../../lib/sidebar-places";
  import type { PanelMenuAnchor } from "../project-panel/lib/panel-items";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { GitPullRequestIcon, IssueOpenedIcon } from "../ui/octicons";

  /** The choice of what the places column shows (docs/plans/sidebar-places-and-sky.md):
   *  a right-click in the column and the Settings row open this one. On a
   *  row, it first moves, hides, or unpins that row. A change applies at once. */
  interface Props {
    open: boolean;
    /** An element, or a point (a right-click) the menu opens at. */
    anchor: PanelMenuAnchor | null;
    target?: SidebarPlacesMenuTarget | null;
    side?: "right" | "bottom";
    align?: "start" | "end";
    /** Where focus goes on close: the prompt from the column, the trigger from Settings. */
    focusOnClose?: "input" | "anchor";
  }
  let {
    open = $bindable(),
    anchor,
    target = null,
    side = "right",
    align = "start",
    focusOnClose = "input",
  }: Props = $props();

  const settings = getSettingsContext();
  const layout = $derived(settings.sidebarPlaces);
  const pins = $derived(settings.sidebarApps);
  const appRows = $derived(appsStore.rows);
  const hasSeveralHosts = $derived(new Set(appRows.map((row) => row.serverId)).size > 1);

  // The Apps submenu lists every app, so the lists are read while the menu is open.
  $effect(() => {
    if (open) return appsStore.watch();
  });

  function moveTarget(direction: "up" | "down") {
    if (!target) return;
    if (target.kind === "place") {
      const onto = direction === "up" ? target.above : target.below;
      if (onto) settings.setPersonal("sidebarPlaces", withPlaceMoved(layout, target.id, onto));
    } else {
      const onto = direction === "up" ? target.above : target.below;
      if (onto) settings.setPersonal("sidebarApps", withAppMoved(pins, target.pin, onto));
    }
  }

  function removeTarget() {
    if (target?.kind === "place") settings.setPersonal("sidebarPlaces", withPlaceShown(layout, target.id, false));
    else if (target?.kind === "app") settings.setPersonal("sidebarApps", withAppPinned(pins, target.pin, false));
  }
</script>

<DropdownMenu.Root bind:open>
  <DropdownMenu.Content
    customAnchor={anchor}
    {side}
    {align}
    sideOffset={6}
    collisionPadding={8}
    onInteractOutside={(event) => {
      // The trigger toggles the menu itself; do not close and reopen here.
      if (anchor instanceof HTMLElement && anchor.contains(event.target as Node | null)) event.preventDefault();
    }}
    onCloseAutoFocus={(event) => {
      event.preventDefault();
      if (focusOnClose === "anchor" && anchor instanceof HTMLElement) anchor.focus();
      else requestInputFocus();
    }}
    class="w-[min(16rem,calc(100vw-2rem))]"
    data-testid="sidebar-places-menu"
  >
    {#if target}
      <DropdownMenu.Item disabled={!target.above} onSelect={() => moveTarget("up")}>Move up</DropdownMenu.Item>
      <DropdownMenu.Item disabled={!target.below} onSelect={() => moveTarget("down")}>Move down</DropdownMenu.Item>
      <DropdownMenu.Item onSelect={removeTarget}>
        <span class="min-w-0 flex-1 truncate">{target.kind === "place" ? `Hide ${target.label}` : `Unpin ${target.label}`}</span>
      </DropdownMenu.Item>
      <DropdownMenu.Separator />
    {/if}
    <DropdownMenu.Label>Places</DropdownMenu.Label>
    {#each orderedPlaces(layout) as place (place.id)}
      <DropdownMenu.CheckboxItem
        closeOnSelect={false}
        bind:checked={
          () => isPlaceShown(layout, place.id),
          (shown) => settings.setPersonal("sidebarPlaces", withPlaceShown(layout, place.id, shown))
        }
      >
        {#if place.id === "tasks"}
          <IssueOpenedIcon />
        {:else if place.id === "prs"}
          <GitPullRequestIcon />
        {:else if place.id === "insights"}
          <ActivityIcon />
        {:else if place.id === "automations"}
          <WorkflowIcon />
        {:else if place.id === "workspace"}
          <LibraryIcon />
        {/if}
        {place.label}
      </DropdownMenu.CheckboxItem>
    {/each}
    <DropdownMenu.Separator />
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger>
        <span class="min-w-0 flex-1 truncate">Pinned apps</span>
        <span class="shrink-0 tabular-nums text-(--solus-text-tertiary)">{pins.length > 0 ? pins.length : ""}</span>
      </DropdownMenu.SubTrigger>
      <DropdownMenu.SubContent class="max-h-[min(24rem,calc(100vh-2rem))] w-[min(16rem,calc(100vw-2rem))] overflow-y-auto">
        {#each appRows as row (`${row.serverId}\n${row.app.id}`)}
          {@const pin = appPinOf(row.serverId, row.app.id, serversStore.hostFor(row.serverId))}
          <DropdownMenu.CheckboxItem
            closeOnSelect={false}
            bind:checked={
              () => isAppPinned(pins, pin),
              (pinned) => settings.setPersonal("sidebarApps", withAppPinned(pins, pin, pinned))
            }
          >
            <span class="min-w-0 flex-1 truncate">{row.app.name}</span>
            {#if hasSeveralHosts}
              <span class="max-w-[45%] shrink-0 truncate text-(--solus-text-tertiary)">
                {serversStore.hostFor(row.serverId)?.label ?? row.serverId}
              </span>
            {/if}
          </DropdownMenu.CheckboxItem>
        {:else}
          <DropdownMenu.Item disabled>
            {appsStore.isLoading ? "Loading apps…" : "No apps yet. Ask an agent to make one."}
          </DropdownMenu.Item>
        {/each}
      </DropdownMenu.SubContent>
    </DropdownMenu.Sub>
    <DropdownMenu.Separator />
    <DropdownMenu.Item
      disabled={!isPlacesLayoutChanged(layout)}
      onSelect={() => settings.setPersonal("sidebarPlaces", { order: [], hidden: [] })}
    >
      Reset places to default
    </DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>
