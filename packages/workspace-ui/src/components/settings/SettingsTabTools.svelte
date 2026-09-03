<script lang="ts">
  import {
    ChevronDown as CaretDownIcon,
    CircleCheck as CircleCheckIcon,
    Download as DownloadIcon,
    LoaderCircle as LoaderIcon,
  } from "@lucide/svelte";
  import { SvelteSet } from "svelte/reactivity";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import {
    getSettingsContext,
    hostCapabilitiesStore,
    toolsStore,
  } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import type { HostApi } from "@solus/client-core/host-api";
  import type { EditorId, TerminalAppId } from "@solus/contracts/types";
  import type { CodeIntelLanguage } from "@solus/contracts/code-intel";
  import { Button } from "../ui/button";
  import AppLogo from "./AppLogo.svelte";
  import { terminalRowDescription } from "./lib/terminal-summary";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import SettingsHostUnsupported from "./SettingsHostUnsupported.svelte";
  import { supportsSettingsSurface } from "@solus/client-core/host-capabilities";
  import CopyButton from "../ui/CopyButton.svelte";
  import { codeIntelStore } from "../code-intel/code-intel.store.svelte";
  import { toasts } from "../../lib/toasts";

  interface Props {
    searchQuery?: string;
    serverId: string;
    api: HostApi;
    hostLabel: string;
  }

  let { searchQuery = "", serverId, api, hostLabel }: Props = $props();

  const theme = getSettingsContext();
  const tools = toolsStore;
  const installingCodeIntel = new SvelteSet<CodeIntelLanguage>();

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

  // Indexers live on the host, not the client: the row answers "can this
  // host navigate Go" for the machine the settings page is looking at.
  const codeIntelLanguages = $derived(codeIntelStore.hostStatusFor(serverId)?.languages ?? []);
  $effect(() => {
    void codeIntelStore.loadStatus(serverId, api, null, undefined).catch(() => {});
  });

  // Re-asked on every visit and on every change of fallback: which terminal
  // holds the session depends on what the user has open right now.
  $effect(() => {
    void tools.refreshResolvedTerminal(theme.fallbackTerminal);
  });

  function selectEditor(editorId: EditorId) {
    theme.update({ defaultEditor: editorId });
    requestInputFocus();
  }

  function selectTerminal(terminalId: TerminalAppId) {
    theme.update({ fallbackTerminal: terminalId });
    requestInputFocus();
  }

  async function installCodeIntel(language: CodeIntelLanguage, label: string, toolName: string) {
    if (installingCodeIntel.has(language)) return;
    installingCodeIntel.add(language);
    const progress = toasts.progress(`Installing ${toolName} on ${hostLabel}…`);
    try {
      const result = await codeIntelStore.install(serverId, api, { language });
      if (!result.ok) {
        progress.error(`Couldn’t install ${toolName}`, { description: result.error });
        return;
      }
      progress.success(`${label} code intelligence is ready`, {
        description: `${toolName} was installed on ${hostLabel}. Indexes build on first use.`,
      });
    } catch (error) {
      progress.error(`Couldn’t install ${toolName}`, {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      installingCodeIntel.delete(language);
    }
  }

  interface SettingItem {
    id: string;
    keywords: string[];
  }

  const settingItems: SettingItem[] = [
    { id: "code-editor", keywords: ["code", "editor", "vscode", "ide", "open"] },
    { id: "terminal", keywords: ["terminal", "shell", "command", "console", "tmux", "fallback"] },
    { id: "code-intel", keywords: ["code", "intelligence", "scip", "index", "definition", "references", "symbol", "navigation", "typescript", "python", "go", "rust"] },
  ];

  function isVisible(id: string): boolean {
    if (!searchQuery) return true;
    const item = settingItems.find((s) => s.id === id);
    if (!item) return true;
    const q = searchQuery.toLowerCase();
    return item.keywords.some((k) => k.includes(q));
  }

  const selectedTerminal = $derived<TerminalAppId>(theme.fallbackTerminal ?? "default-terminal");
  const selectedEditorApp = $derived(detected.editors.find((e) => e.id === theme.defaultEditor));
  const selectedTerminalApp = $derived(detected.terminals.find((t) => t.id === selectedTerminal));
  const resolvedDescription = $derived(terminalRowDescription(tools.resolvedTerminal));
  const editorVisible = $derived(isVisible("code-editor") && detected.editors.length > 0);
  const terminalVisible = $derived(isVisible("terminal") && detected.terminals.length > 0);
  const codeIntelVisible = $derived(isVisible("code-intel") && codeIntelLanguages.length > 0);
  const anyVisible = $derived(settingItems.some((s) => isVisible(s.id)));
</script>

{#if capabilities === undefined}
  <div class="py-10 text-center text-workspace-chrome text-(--solus-text-tertiary) [.is-laptop-display_&]:py-8" role="status">
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
            <Button {...props} variant="outline" size="sm" aria-label="Code editor" class="min-w-32 justify-between gap-2 text-xs shadow-xs">
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
    label="Fallback terminal"
    description={resolvedDescription}
    visible={terminalVisible}
  >
    {#snippet control()}
      <DropdownMenu.Root onOpenChange={(next) => { if (!next) requestInputFocus() }}>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button {...props} variant="outline" size="sm" aria-label="Fallback terminal" class="min-w-32 justify-between gap-2 text-xs shadow-xs">
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

<!-- Cmd-click an identifier in a diff or file to see its definition and
     references. Each language needs its SCIP indexer on this host's PATH. -->
<SettingsSection label="Code intelligence" visible={codeIntelVisible}>
  {#each codeIntelLanguages as language (language.language)}
    <SettingsRow
      label={language.label}
      description={language.toolInstalled
        ? `${language.toolName} is installed. Indexes build on first use per project.`
        : `Install ${language.toolName} to navigate ${language.label} symbols.`}
    >
      {#snippet labelExtra()}
        <!-- Installed reads as the same check every other live row in Settings
             uses, not a bespoke pill: a shape, so it survives both themes. -->
        {#if language.toolInstalled}
          <CircleCheckIcon
            size={13}
            role="img"
            aria-label="{language.toolName} is installed"
            class="ml-1.5 inline-block shrink-0 align-[-0.15em] text-(--solus-status-complete)"
          />
        {/if}
      {/snippet}
      {#snippet control()}
        {#if !language.toolInstalled}
          <Button
            variant="outline"
            size="sm"
            class="min-w-29 transition-transform active:scale-[0.96]"
            disabled={installingCodeIntel.has(language.language)}
            onclick={() => installCodeIntel(language.language, language.label, language.toolName)}
          >
            {#if installingCodeIntel.has(language.language)}
              <LoaderIcon class="animate-spin" aria-hidden="true" />
              Installing…
            {:else}
              <DownloadIcon aria-hidden="true" />
              Install for me
            {/if}
          </Button>
        {/if}
      {/snippet}
      {#snippet body()}
        {#if !language.toolInstalled}
          <div class="flex min-w-0 items-center gap-2">
            <span class="shrink-0 text-[0.875em] text-muted-foreground">Or install manually</span>
            <div class="flex min-w-0 flex-1 items-center gap-1 rounded-lg border border-border bg-(--solus-surface-hover) py-0.5 pr-0.5 pl-2.5">
              <code class="min-w-0 flex-1 truncate font-[family-name:var(--solus-code-font-family)] text-[length:var(--solus-code-font-size)] text-(--solus-text-secondary)" title={language.installCommand}>
                {language.installCommand}
              </code>
              <CopyButton text={language.installCommand} title="Copy install command" iconOnly />
            </div>
          </div>
        {/if}
      {/snippet}
    </SettingsRow>
  {/each}
</SettingsSection>

{#if !anyVisible}
  <div class="py-8 text-center text-workspace-chrome text-(--solus-text-tertiary) [.is-laptop-display_&]:py-6">
    No settings match your search
  </div>
{/if}
{/if}
