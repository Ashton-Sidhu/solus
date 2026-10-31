<script lang="ts">
  import { requestInputFocus } from "../../lib/inputFocus";
  import { getSettingsContext } from "../../contexts";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import {
    PROJECT_PANEL_SECTIONS,
    isPanelItemShown,
    shownRowCount,
    withPanelItemShown,
    type PanelMenuAnchor,
    type ProjectPanelItemId,
  } from "./lib/panel-items";

  /** The choice of what the project panel shows: the panel's own menu and the
   *  Settings row open this one. A change applies at once. */
  interface Props {
    open: boolean;
    /** An element, or a point (a right-click) the menu opens at. */
    anchor: PanelMenuAnchor | null;
    side?: "left" | "bottom";
    align?: "start" | "end";
    /** Where focus goes on close: the prompt from the panel, the trigger from Settings. */
    focusOnClose?: "input" | "anchor";
  }
  let { open = $bindable(), anchor, side = "left", align = "start", focusOnClose = "input" }: Props = $props();

  const settings = getSettingsContext();
  const hidden = $derived(settings.projectPanelHiddenItems);
</script>

{#snippet checkbox(id: ProjectPanelItemId, label: string, disabled: boolean)}
  <DropdownMenu.CheckboxItem
    closeOnSelect={false}
    {disabled}
    bind:checked={
      () => isPanelItemShown(hidden, id),
      (shown) => settings.setPersonal("projectPanelHiddenItems", withPanelItemShown(hidden, id, shown))
    }
  >
    {label}
  </DropdownMenu.CheckboxItem>
{/snippet}

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
  >
    <!-- One submenu per section: the section itself, then each kind of row
         in it. The rows of a hidden section cannot show, so they wait. -->
    {#each PROJECT_PANEL_SECTIONS as section (section.id)}
      {#if section.rows.length === 0}
        {@render checkbox(section.id, section.label, false)}
      {:else}
        {@const sectionShown = isPanelItemShown(hidden, section.id)}
        <DropdownMenu.Sub>
          <DropdownMenu.SubTrigger>
            <span class="min-w-0 flex-1 truncate">{section.label}</span>
            <span class="shrink-0 tabular-nums text-(--solus-text-tertiary)">
              {sectionShown ? `${shownRowCount(hidden, section)} of ${section.rows.length}` : "Hidden"}
            </span>
          </DropdownMenu.SubTrigger>
          <DropdownMenu.SubContent class="w-[min(16rem,calc(100vw-2rem))]">
            {@render checkbox(section.id, `Show ${section.label}`, false)}
            <DropdownMenu.Separator />
            {#each section.rows as row (row.id)}
              {@render checkbox(row.id, row.label, !sectionShown)}
            {/each}
          </DropdownMenu.SubContent>
        </DropdownMenu.Sub>
      {/if}
    {/each}
    <DropdownMenu.Separator />
    <DropdownMenu.Item
      disabled={hidden.length === 0}
      onSelect={() => settings.setPersonal("projectPanelHiddenItems", [])}
    >
      Reset to default
    </DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>
