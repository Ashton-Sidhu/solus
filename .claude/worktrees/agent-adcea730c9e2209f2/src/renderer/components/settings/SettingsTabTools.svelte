<script lang="ts">
  import {
    CodeIcon,
    TerminalWindowIcon,
    CaretDownIcon,
  } from "phosphor-svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
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
      <DropdownMenu.Root bind:open={editorOpen} onOpenChange={(next) => { if (!next) requestInputFocus() }}>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}<button
          {...props}
          type="button"
          class={dropdownTriggerClass}
        >
          <span class="max-w-28 truncate">{tools.detectedEditors.find((e) => e.id === theme.defaultEditor)?.name ?? "None"}</span>
          <CaretDownIcon size={11} style="opacity:0.6" />
        </button>{/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[160px]">
          <DropdownMenu.RadioGroup value={theme.defaultEditor ?? ""}>
            {#each tools.detectedEditors as editor (editor.id)}
              <DropdownMenu.RadioItem value={editor.id} onSelect={() => selectEditor(editor.id)}><span class="truncate">{editor.name}</span></DropdownMenu.RadioItem>
            {/each}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
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
      <DropdownMenu.Root bind:open={terminalOpen} onOpenChange={(next) => { if (!next) requestInputFocus() }}>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}<button
          {...props}
          type="button"
          class={dropdownTriggerClass}
        >
          <span class="max-w-28 truncate">{tools.detectedTerminals.find((t) => t.id === (theme.defaultTerminal ?? "default-terminal"))?.name ?? "Default"}</span>
          <CaretDownIcon size={11} style="opacity:0.6" />
        </button>{/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[160px]">
          <DropdownMenu.RadioGroup value={theme.defaultTerminal ?? "default-terminal"}>
            {#each tools.detectedTerminals as terminal (terminal.id)}
              <DropdownMenu.RadioItem value={terminal.id} onSelect={() => selectTerminal(terminal.id)}><span class="truncate">{terminal.name}</span></DropdownMenu.RadioItem>
            {/each}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>
  {/if}

  {#if !anyVisible}
    <div class="py-8 text-center text-[0.8125rem] text-(--solus-text-tertiary)">
      No settings match your search
    </div>
  {/if}
</div>
