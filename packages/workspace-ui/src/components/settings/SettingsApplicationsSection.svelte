<script lang="ts">
  import { settingsDefinitions } from "@solus/client-core/settings-definitions";
  import { ChevronDown as CaretDownIcon } from "@lucide/svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { getSettingsContext, hosts, toolsStore } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import type { EditorId, TerminalAppId } from "@solus/contracts/types";
  import { Button } from "../ui/button";
  import AppLogo from "./AppLogo.svelte";
  import { terminalRowDescription } from "./lib/terminal-summary";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";

  /** The code editor and fallback terminal of this device. A row shows only
   *  when the selected host detects at least one app for it. */
  let { serverId, isVisible }: { serverId: string; isVisible: (id: string) => boolean } = $props();

  const theme = getSettingsContext();
  const tools = toolsStore;

  const host = $derived(hosts.get(serverId));
  // The host limits detected editors to the ones it advertises.
  const detected = $derived(host.tools.state === "ready" ? host.tools.value : { editors: [], terminals: [] });

  // Re-asked on every visit and on every change of fallback: which terminal
  // holds the session depends on what the user has open right now.
  $effect(() => {
    void tools.refreshResolvedTerminal(theme.fallbackTerminal);
  });

  function selectEditor(editorId: EditorId) {
    theme.setDevice("defaultEditor", editorId);
    requestInputFocus();
  }

  function selectTerminal(terminalId: TerminalAppId) {
    theme.setDevice("fallbackTerminal", terminalId);
    requestInputFocus();
  }

  const selectedTerminal = $derived<TerminalAppId>(theme.fallbackTerminal ?? "default-terminal");
  const selectedEditorApp = $derived(detected.editors.find((e) => e.id === theme.defaultEditor));
  const selectedTerminalApp = $derived(detected.terminals.find((t) => t.id === selectedTerminal));
  const resolvedDescription = $derived(terminalRowDescription(tools.resolvedTerminal));
  const editorVisible = $derived(isVisible("code-editor") && detected.editors.length > 0);
  const terminalVisible = $derived(isVisible("terminal") && detected.terminals.length > 0);
</script>

<SettingsSection {...settingsDefinitions["general.section-applications"]} visible={editorVisible || terminalVisible}>
  <SettingsRow
    {...settingsDefinitions["general.code-editor"]}
    visible={editorVisible}
  >
    {#snippet control()}
      <DropdownMenu.Root onOpenChange={(next) => { if (!next) requestInputFocus() }}>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button {...props} variant="outline" size="sm" aria-label="Code editor" class="min-w-32 justify-between gap-2 text-xs font-normal shadow-xs">
              <span class="flex min-w-0 items-center gap-1.5">
                <AppLogo id={theme.defaultEditor} kind="editor" size={13} />
                <span class="max-w-28 truncate">{selectedEditorApp?.name ?? "None"}</span>
              </span>
              <CaretDownIcon size={11} style="opacity:0.6" />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[180px]">
          <DropdownMenu.RadioGroup value={theme.defaultEditor ?? ""}>
            {#each detected.editors as editor (editor.id)}
              <DropdownMenu.RadioItem value={editor.id} onSelect={() => selectEditor(editor.id)}>
                <AppLogo id={editor.id} kind="editor" size={13} />
                <span class="truncate">{editor.name}</span>
              </DropdownMenu.RadioItem>
            {/each}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/snippet}
  </SettingsRow>

  <SettingsRow
    {...settingsDefinitions["general.fallback-terminal"]}
    description={resolvedDescription}
    visible={terminalVisible}
  >
    {#snippet control()}
      <DropdownMenu.Root onOpenChange={(next) => { if (!next) requestInputFocus() }}>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button {...props} variant="outline" size="sm" aria-label="Fallback terminal" class="min-w-32 justify-between gap-2 text-xs font-normal shadow-xs">
              <span class="flex min-w-0 items-center gap-1.5">
                <AppLogo id={selectedTerminal} kind="terminal" size={13} />
                <span class="max-w-28 truncate">{selectedTerminalApp?.name ?? "Default"}</span>
              </span>
              <CaretDownIcon size={11} style="opacity:0.6" />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[180px]">
          <DropdownMenu.RadioGroup value={selectedTerminal}>
            {#each detected.terminals as terminal (terminal.id)}
              <DropdownMenu.RadioItem value={terminal.id} onSelect={() => selectTerminal(terminal.id)}>
                <AppLogo id={terminal.id} kind="terminal" size={13} />
                <span class="truncate">{terminal.name}</span>
              </DropdownMenu.RadioItem>
            {/each}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/snippet}
  </SettingsRow>
</SettingsSection>
