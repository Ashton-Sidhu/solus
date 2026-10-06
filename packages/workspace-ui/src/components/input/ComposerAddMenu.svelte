<script lang="ts">
  import {
    Camera as CameraIcon,
    FolderPlus as FolderPlusIcon,
    HardDrive as HostIcon,
    MousePointerClick as DesignModeIcon,
    Paperclip as PaperclipIcon,
    Plus as PlusIcon,
  } from "@lucide/svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { requestInputFocus } from "../../lib/inputFocus";

  interface Props {
    onAttachFile: () => void;
    onScreenshot?: (() => void) | null;
    onDesignMode?: (() => void) | null;
    /** Only a chat that has not started offers this: a chat has no project
     *  strip, so its project list opens from here, anchored to this button. */
    onAddProject?: ((anchor: HTMLElement) => void) | null;
    /** A chat's host choice, offered when there is more than one host. The
     *  Run on list opens from here; `runOnLabel` names the current host. */
    onRunOn?: ((anchor: HTMLElement) => void) | null;
    runOnLabel?: string | null;
    /** The workspace's own composer: closing the menu returns the caret to it. */
    isPrimary?: boolean;
    disabled?: boolean;
    attachDisabled?: boolean;
    /** Why attaching is off on this host, shown under the item. */
    attachNote?: string | null;
  }
  let {
    onAttachFile,
    onScreenshot,
    onDesignMode,
    onAddProject,
    onRunOn,
    runOnLabel = null,
    isPrimary = false,
    disabled = false,
    attachDisabled = false,
    attachNote = null,
  }: Props = $props();

  let open = $state(false);
  let triggerEl = $state<HTMLButtonElement | null>(null);
  /** Set when an item takes over: it owns focus next, not the composer. */
  let handedOff = false;
  /** A row that opens another list; that list opens once this menu has closed. */
  let pendingList: ((anchor: HTMLElement) => void) | null = null;

  function choose(action: () => void) {
    handedOff = true;
    action();
  }

  function openListAfterClose(openList: ((anchor: HTMLElement) => void) | null | undefined) {
    if (!openList) return;
    handedOff = true;
    pendingList = openList;
  }

  function handleCloseAutoFocus(event: Event) {
    event.preventDefault();
    const tookFocus = handedOff;
    handedOff = false;
    if (!tookFocus && isPrimary) requestInputFocus();
  }

  /** The next list opens only once this menu is gone. While the menu fades
   *  out it still traps focus, so it pulled focus back from a list opened any
   *  sooner, and the list closed in the same frame. */
  function handleOpenChangeComplete(isOpen: boolean) {
    if (isOpen || !pendingList) return;
    const openList = pendingList;
    pendingList = null;
    if (triggerEl) openList(triggerEl);
  }
</script>

<!--
  One quiet button that opens a menu, the same 30px borderless shell as the
  mode and model pickers. It does not grow on hover: a control that widens
  pushes its neighbours sideways, and a touch screen has no hover to reveal
  what was hidden. Every action is a menu row instead, with its shortcut.
-->
<DropdownMenu.Root bind:open onOpenChangeComplete={handleOpenChangeComplete}>
  <DropdownMenu.Trigger {disabled} bind:ref={triggerEl}>
    {#snippet child({ props })}
      <TooltipUI.Root>
        <TooltipUI.Trigger>
          {#snippet child({ props: tooltipProps })}
            <button
              {...tooltipProps}
              {...props}
              type="button"
              aria-label="Add"
              class="flex size-[1.875rem] shrink-0 items-center justify-center rounded-lg text-(--solus-text-tertiary) transition-[background-color,color,scale] duration-[var(--duration-quick)] ease-(--ease-premium) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary) active:scale-[0.96] focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary) focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:size-10 {open
                ? 'bg-(--solus-surface-hover) text-(--solus-text-secondary)'
                : ''}"
            >
              <PlusIcon
                size={16}
                class="transition-transform duration-[var(--duration-quick)] ease-(--ease-premium) motion-reduce:transition-none {open
                  ? 'rotate-45'
                  : ''}"
              />
            </button>
          {/snippet}
        </TooltipUI.Trigger>
        <TooltipUI.Content value={open ? null : "Add files and more"} />
      </TooltipUI.Root>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content
    side="top"
    align="start"
    sideOffset={6}
    onCloseAutoFocus={handleCloseAutoFocus}
    class="w-[min(16rem,calc(100vw-2rem))] text-workspace-chrome [&_.menu-row]:text-workspace-chrome"
  >
    <DropdownMenu.Item disabled={attachDisabled} onSelect={() => choose(onAttachFile)}>
      <PaperclipIcon class="size-4 text-(--solus-text-tertiary)" />
      <span class="flex min-w-0 flex-1 flex-col">
        <span>Attach files</span>
        {#if attachDisabled && attachNote}
          <span class="truncate text-xs text-(--solus-text-tertiary)">{attachNote}</span>
        {/if}
      </span>
      <DropdownMenu.Shortcut>{comboHint("global.attach-file")}</DropdownMenu.Shortcut>
    </DropdownMenu.Item>
    {#if onScreenshot}
      <DropdownMenu.Item onSelect={() => choose(onScreenshot)}>
        <CameraIcon class="size-4 text-(--solus-text-tertiary)" />
        <span class="flex-1">Take screenshot</span>
        <DropdownMenu.Shortcut>{comboHint("global.screenshot")}</DropdownMenu.Shortcut>
      </DropdownMenu.Item>
    {/if}
    {#if onDesignMode}
      <DropdownMenu.Item onSelect={() => choose(onDesignMode)}>
        <DesignModeIcon class="size-4 text-(--solus-text-tertiary)" />
        <span class="flex-1">Design mode</span>
        {#if comboHint("global.design-mode")}
          <DropdownMenu.Shortcut>{comboHint("global.design-mode")}</DropdownMenu.Shortcut>
        {/if}
      </DropdownMenu.Item>
    {/if}
    {#if onAddProject || (onRunOn && runOnLabel)}
      <DropdownMenu.Separator />
    {/if}
    {#if onAddProject}
      <DropdownMenu.Item onSelect={() => openListAfterClose(onAddProject)}>
        <FolderPlusIcon class="size-4 text-(--solus-text-tertiary)" />
        <span class="flex-1">Add project…</span>
      </DropdownMenu.Item>
    {/if}
    {#if onRunOn && runOnLabel}
      <DropdownMenu.Item onSelect={() => openListAfterClose(onRunOn)}>
        <HostIcon class="size-4 text-(--solus-text-tertiary)" />
        <span class="flex-1">Run on…</span>
        <span class="max-w-28 truncate text-xs text-(--solus-text-tertiary)">{runOnLabel}</span>
      </DropdownMenu.Item>
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>
