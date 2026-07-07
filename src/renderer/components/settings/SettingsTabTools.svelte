<script lang="ts">
  import {
    CodeIcon,
    TerminalWindowIcon,
    CheckIcon,
    CaretDownIcon,
  } from "phosphor-svelte";
  import Dropdown from "../ui/Dropdown.svelte";
  import DropdownItem from "../ui/DropdownItem.svelte";
  import { getSettingsContext } from "../../contexts/settings.context.svelte";
  import { toolsStore } from "../../contexts/tools.store.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { onMount } from "svelte";

  interface Props {
    searchQuery?: string;
  }

  let { searchQuery = "" }: Props = $props();

  const theme = getSettingsContext();
  const tools = toolsStore;

  let editorOpen = $state(false);
  let terminalOpen = $state(false);
  let editorTriggerEl: HTMLButtonElement | null = $state(null);
  let terminalTriggerEl: HTMLButtonElement | null = $state(null);

  onMount(async () => {
    await tools.loadDetectedTools();
  });

  function selectEditor(editorId: string) {
    theme.update({ defaultEditor: editorId });
    editorOpen = false;
    requestInputFocus();
  }

  function selectTerminal(terminalId: string) {
    theme.update({ defaultTerminal: terminalId });
    terminalOpen = false;
    requestInputFocus();
  }

  interface SettingItem {
    id: string;
    keywords: string[];
  }

  const settingItems: SettingItem[] = [
    { id: "code-editor", keywords: ["code", "editor", "vscode", "ide", "open"] },
    { id: "terminal", keywords: ["terminal", "shell", "command", "console"] },
  ];

  function isVisible(id: string): boolean {
    if (!searchQuery) return true;
    const item = settingItems.find((s) => s.id === id);
    if (!item) return true;
    const q = searchQuery.toLowerCase();
    return item.keywords.some((k) => k.includes(q));
  }

  const anyVisible = $derived(settingItems.some((s) => isVisible(s.id)));

  const dropdownTriggerClass = "flex items-center justify-between gap-1.5 min-h-8 border border-(--solus-container-border) rounded-lg bg-(--solus-input-bg-soft) text-(--solus-text-secondary) px-2.5 text-[0.8125rem] outline-none [transition:border-color_var(--duration-base)_var(--ease-premium),box-shadow_var(--duration-base)_var(--ease-premium),color_var(--duration-base)_var(--ease-premium)] hover:text-(--solus-text-primary) hover:border-(--solus-input-focus-border) focus-visible:text-(--solus-text-primary) focus-visible:border-(--solus-input-focus-border) focus-visible:shadow-[0_0_0_0.1875rem_var(--solus-input-focus-ring)]";
</script>

<div class="flex flex-col">
  {#if isVisible("code-editor") && tools.detectedEditors.length > 0}
    <div class="flex items-center justify-between gap-4 py-3.5 border-b border-b-(--solus-container-border)/50 last:border-b-0">
      <div class="flex items-center gap-3 min-w-0">
        <CodeIcon size={16} class="shrink-0 text-(--solus-text-tertiary)" />
        <div>
          <div class="text-[0.8125rem] font-medium text-(--solus-text-primary)">Code editor</div>
          <div class="text-[clamp(0.6875rem,0.64rem+0.2vw,0.8125rem)] text-(--solus-text-tertiary) mt-px">Open files in this editor</div>
        </div>
      </div>
      <div>
        <button
          bind:this={editorTriggerEl}
          type="button"
          aria-haspopup="menu"
          aria-expanded={editorOpen}
          onclick={() => { editorOpen = !editorOpen; terminalOpen = false }}
          class={dropdownTriggerClass}
        >
          <span class="max-w-28 truncate">{tools.detectedEditors.find((e) => e.id === theme.defaultEditor)?.name ?? "None"}</span>
          <CaretDownIcon size={11} style="opacity:0.6" />
        </button>
        <Dropdown bind:open={editorOpen} triggerEl={editorTriggerEl} align="top" anchor="right" width={160}>
          <div class="py-1">
            {#each tools.detectedEditors as editor (editor.id)}
              <DropdownItem selected={(theme.defaultEditor ?? "") === editor.id} onclick={() => selectEditor(editor.id)}>
                <span class="truncate">{editor.name}</span>
                {#if (theme.defaultEditor ?? "") === editor.id}<CheckIcon size={14} class="text-(--solus-accent)" />{/if}
              </DropdownItem>
            {/each}
          </div>
        </Dropdown>
      </div>
    </div>
  {/if}

  {#if isVisible("terminal") && tools.detectedTerminals.length > 0}
    <div class="flex items-center justify-between gap-4 py-3.5 border-b border-b-(--solus-container-border)/50 last:border-b-0">
      <div class="flex items-center gap-3 min-w-0">
        <TerminalWindowIcon size={16} class="shrink-0 text-(--solus-text-tertiary)" />
        <div>
          <div class="text-[0.8125rem] font-medium text-(--solus-text-primary)">Terminal</div>
          <div class="text-[clamp(0.6875rem,0.64rem+0.2vw,0.8125rem)] text-(--solus-text-tertiary) mt-px">Default terminal application</div>
        </div>
      </div>
      <div>
        <button
          bind:this={terminalTriggerEl}
          type="button"
          aria-haspopup="menu"
          aria-expanded={terminalOpen}
          onclick={() => { terminalOpen = !terminalOpen; editorOpen = false }}
          class={dropdownTriggerClass}
        >
          <span class="max-w-28 truncate">{tools.detectedTerminals.find((t) => t.id === (theme.defaultTerminal ?? "default-terminal"))?.name ?? "Default"}</span>
          <CaretDownIcon size={11} style="opacity:0.6" />
        </button>
        <Dropdown bind:open={terminalOpen} triggerEl={terminalTriggerEl} align="top" anchor="right" width={160}>
          <div class="py-1">
            {#each tools.detectedTerminals as terminal (terminal.id)}
              <DropdownItem selected={(theme.defaultTerminal ?? "default-terminal") === terminal.id} onclick={() => selectTerminal(terminal.id)}>
                <span class="truncate">{terminal.name}</span>
                {#if (theme.defaultTerminal ?? "default-terminal") === terminal.id}<CheckIcon size={14} class="text-(--solus-accent)" />{/if}
              </DropdownItem>
            {/each}
          </div>
        </Dropdown>
      </div>
    </div>
  {/if}

  {#if !anyVisible}
    <div class="py-8 text-center text-[0.8125rem] text-(--solus-text-tertiary)">
      No settings match your search
    </div>
  {/if}
</div>

{#snippet toggle(checked: boolean, onChange: (next: boolean) => void, label: string)}
  <button
    type="button"
    aria-label={label}
    aria-pressed={checked}
    onclick={() => onChange(!checked)}
    class="relative w-[2.375rem] h-[1.375rem] rounded-[0.6875rem] border cursor-pointer shrink-0 [transition:background_0.2s_ease,border-color_0.2s_ease]
      {checked ? 'bg-(--solus-accent) border-(--solus-accent)' : 'bg-(--solus-surface-secondary) border-(--solus-container-border)'}"
  >
    <span class="absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-lg bg-white [transition:left_0.2s_ease] shadow-[0_1px_3px_rgba(0,0,0,0.1)]" style="left:{checked ? 20 : 3}px"></span>
  </button>
{/snippet}
