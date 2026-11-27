<script lang="ts">
  import {
    AppWindow as WindowIcon,
    Ellipsis as MenuIcon,
    MonitorDown as AddShortcutIcon,
    MonitorOff as RemoveShortcutIcon,
    Pin as PinIcon,
    PinOff as UnpinIcon,
    Play as StartIcon,
    Square as StopIcon,
    Trash2 as DeleteIcon,
  } from "@lucide/svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { PAGE_SOFT_ICON_BTN } from "../../lib/page-chrome";
  import type { AppShortcutChange } from "../../contexts/apps/app-shortcuts.store.svelte";
  import { shortcutCommandLabel } from "../../contexts/apps/app-shortcut-messages";

  /**
   * The app menu (docs/plans/apps.md §9.1): Stop or Start, Pin to sidebar or
   * Unpin, on desktop the app's own window and its shortcut
   * (docs/app-shortcuts.md), then Delete. What else an owner does to an app
   * is on its Manage page.
   */
  interface Props {
    stopped: boolean;
    /** The app is pinned in the sidebar's places column. */
    pinned: boolean;
    disabled: boolean;
    onToggleStopped: () => void;
    onTogglePinned: () => void;
    onDelete: () => void;
    /** The app window and the shortcut of an app with a UI. Absent on a client that has neither (web). */
    desktop?: { hasShortcut: boolean; shortcutChange: AppShortcutChange | null; onOpenWindow: () => void; onToggleShortcut: () => void };
  }
  let { stopped, pinned, disabled, onToggleStopped, onTogglePinned, onDelete, desktop }: Props = $props();
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <button {...props} type="button" class="{PAGE_SOFT_ICON_BTN} disabled:cursor-not-allowed disabled:opacity-50" aria-label="App menu" title="App menu" data-testid="app-menu">
        <MenuIcon size={15} strokeWidth={1.5} />
      </button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end" sideOffset={6} collisionPadding={8} class="w-auto min-w-40 max-w-[min(20rem,calc(100vw-2rem))] whitespace-nowrap">
    <DropdownMenu.Item class="text-workspace-chrome" {disabled} data-testid="app-menu-toggle-stopped" onSelect={onToggleStopped}>
      {#if stopped}
        <StartIcon size={14} /><span class="flex-1 text-left">Start</span>
      {:else}
        <StopIcon size={14} /><span class="flex-1 text-left">Stop</span>
      {/if}
    </DropdownMenu.Item>
    <DropdownMenu.Item class="text-workspace-chrome" data-testid="app-menu-toggle-pinned" onSelect={onTogglePinned}>
      {#if pinned}
        <UnpinIcon size={14} /><span class="flex-1 text-left">Unpin from sidebar</span>
      {:else}
        <PinIcon size={14} /><span class="flex-1 text-left">Pin to sidebar</span>
      {/if}
    </DropdownMenu.Item>
    {#if desktop}
      <DropdownMenu.Item class="text-workspace-chrome" data-testid="app-menu-open-window" onSelect={desktop.onOpenWindow}>
        <WindowIcon size={14} /><span class="flex-1 text-left">Open in its own window</span>
      </DropdownMenu.Item>
      <DropdownMenu.Item class="text-workspace-chrome" disabled={disabled || desktop.shortcutChange !== null} data-testid="app-menu-toggle-shortcut" onSelect={desktop.onToggleShortcut}>
        {#if desktop.hasShortcut}<RemoveShortcutIcon size={14} />{:else}<AddShortcutIcon size={14} />{/if}
        <span class="flex-1 text-left">{shortcutCommandLabel(desktop.hasShortcut, desktop.shortcutChange)}</span>
      </DropdownMenu.Item>
    {/if}
    <DropdownMenu.Item class="text-workspace-chrome text-destructive" {disabled} data-testid="app-menu-delete" onSelect={onDelete}>
      <DeleteIcon size={14} /><span class="flex-1 text-left">Delete…</span>
    </DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>
