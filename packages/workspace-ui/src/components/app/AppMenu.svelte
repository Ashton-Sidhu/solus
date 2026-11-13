<script lang="ts">
  import { Ellipsis as MenuIcon, Play as StartIcon, Square as StopIcon, Trash2 as DeleteIcon } from "@lucide/svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { PAGE_ICON_BTN } from "../../lib/page-chrome";

  /**
   * The app menu (docs/plans/apps.md §9.1): Stop or Start, then Delete. What
   * else an owner does to an app is on its Manage page.
   */
  interface Props {
    stopped: boolean;
    disabled: boolean;
    onToggleStopped: () => void;
    onDelete: () => void;
  }
  let { stopped, disabled, onToggleStopped, onDelete }: Props = $props();
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <button {...props} type="button" class={PAGE_ICON_BTN} aria-label="App menu" title="App menu" data-testid="app-menu">
        <MenuIcon size={16} />
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
    <DropdownMenu.Item class="text-workspace-chrome text-destructive" {disabled} data-testid="app-menu-delete" onSelect={onDelete}>
      <DeleteIcon size={14} /><span class="flex-1 text-left">Delete…</span>
    </DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>
