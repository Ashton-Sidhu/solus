<script lang="ts">
  import { CaretDownIcon } from "phosphor-svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import {
    getSettingsContext,
    hostCapabilitiesStore,
    toolsStore,
  } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import type { HostApi } from "@client-core/host-api";
  import type { EditorId, TerminalAppId } from "../../../shared/types";
  import { Button } from "../ui/button";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import SettingsHostUnsupported from "./SettingsHostUnsupported.svelte";
  import { supportsSettingsSurface } from "@client-core/host-capabilities";

  interface Props {
    searchQuery?: string;
    serverId: string;
    api: HostApi;
    hostLabel: string;
  }

  let { searchQuery = "", serverId, api, hostLabel }: Props = $props();

  const theme = getSettingsContext();
  const tools = toolsStore;

  const capabilities = $derived(hostCapabilitiesStore.for(serverId));
  const isSupported = $derived(supportsSettingsSurface(capabilities, "tools"));
  const detected = $derived.by(() => {
    const value = tools.detectedFor(serverId);
    const editorIds = capabilities?.editors ?? [];
    return {
      editors: value.editors.filter((editor) => editorIds.includes(editor.id)),
      terminals: value.terminals,
    };
  });

  $effect(() => {
    void hostCapabilitiesStore.load(serverId);
    if (isSupported) void tools.loadDetectedToolsFor(serverId, api);
  });

  function selectEditor(editorId: EditorId) {
    theme.update({ defaultEditor: editorId });
    requestInputFocus();
  }

  function selectTerminal(terminalId: TerminalAppId) {
    theme.update({ defaultTerminal: terminalId });
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

  const editorVisible = $derived(isVisible("code-editor") && detected.editors.length > 0);
  const terminalVisible = $derived(isVisible("terminal") && detected.terminals.length > 0);
  const anyVisible = $derived(settingItems.some((s) => isVisible(s.id)));
</script>

{#if capabilities === undefined}
  <div class="py-10 text-center text-[0.8125rem] text-(--solus-text-tertiary)" role="status">
    Checking application support…
  </div>
{:else if !isSupported}
  <SettingsHostUnsupported feature="Applications" {hostLabel} />
{:else}
<SettingsSection label="Applications" visible={editorVisible || terminalVisible}>
  <SettingsRow
    label="Code editor"
    description="Where “Open in editor” sends files."
    visible={editorVisible}
  >
    {#snippet control()}
      <DropdownMenu.Root onOpenChange={(next) => { if (!next) requestInputFocus() }}>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button {...props} variant="outline" size="sm" aria-label="Code editor" class="min-w-28 justify-between text-xs shadow-xs">
              <span class="max-w-28 truncate">{detected.editors.find((e) => e.id === theme.defaultEditor)?.name ?? "None"}</span>
              <CaretDownIcon size={11} style="opacity:0.6" />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[160px]">
          <DropdownMenu.RadioGroup value={theme.defaultEditor ?? ""}>
            {#each detected.editors as editor (editor.id)}
              <DropdownMenu.RadioItem value={editor.id} onSelect={() => selectEditor(editor.id)}><span class="truncate">{editor.name}</span></DropdownMenu.RadioItem>
            {/each}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Terminal"
    description="Where “Open in terminal” launches a shell."
    visible={terminalVisible}
  >
    {#snippet control()}
      <DropdownMenu.Root onOpenChange={(next) => { if (!next) requestInputFocus() }}>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button {...props} variant="outline" size="sm" aria-label="Terminal" class="min-w-28 justify-between text-xs shadow-xs">
              <span class="max-w-28 truncate">{detected.terminals.find((t) => t.id === (theme.defaultTerminal ?? "default-terminal"))?.name ?? "Default"}</span>
              <CaretDownIcon size={11} style="opacity:0.6" />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[160px]">
          <DropdownMenu.RadioGroup value={theme.defaultTerminal ?? "default-terminal"}>
            {#each detected.terminals as terminal (terminal.id)}
              <DropdownMenu.RadioItem value={terminal.id} onSelect={() => selectTerminal(terminal.id)}><span class="truncate">{terminal.name}</span></DropdownMenu.RadioItem>
            {/each}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/snippet}
  </SettingsRow>
</SettingsSection>

{#if !anyVisible}
  <div class="py-8 text-center text-[0.8125rem] text-(--solus-text-tertiary)">
    No settings match your search
  </div>
{/if}
{/if}
