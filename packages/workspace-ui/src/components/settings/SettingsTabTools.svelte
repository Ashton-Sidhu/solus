<script lang="ts">
  import { settingVisible } from "@solus/client-core/settings-search";
  import { settingsDefinitions } from "@solus/client-core/settings-definitions";
  import { toolSettings as settingItems } from "./lib/settings-search-data";
  import {
    CircleCheck as CircleCheckIcon,
    Download as DownloadIcon,
    LoaderCircle as LoaderIcon,
  } from "@lucide/svelte";
  import { untrack } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { hosts } from "../../contexts";
  import type { HostApi } from "@solus/client-core/host-api";
  import type { CodeIntelLanguage } from "@solus/contracts/code-intel";
  import { Button } from "../ui/button";
  import SolusToolSettings from "./SolusToolSettings.svelte";
  import TypeSafeKeySetting from "./TypeSafeKeySetting.svelte";
  import { solusToolsStore } from "./solus-tools.store.svelte";
  import { matchingToolGroups } from "./lib/solus-tool-groups";
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

  const installingCodeIntel = new SvelteSet<CodeIntelLanguage>();

  const host = $derived(hosts.get(serverId));
  const capabilities = $derived(host.capabilityRecord);
  const isSupported = $derived(supportsSettingsSurface(capabilities, "tools"));

  // One watch feeds both the TypeSafe key group and the Solus tools group.
  $effect(() => {
    const hostId = serverId;
    return untrack(() => solusToolsStore.watch(hostId));
  });

  // Indexers live on the host, not the client: the row answers "can this
  // host navigate Go" for the machine the settings page is looking at.
  const codeIntelLanguages = $derived(codeIntelStore.hostStatusFor(serverId)?.languages ?? []);
  $effect(() => {
    void codeIntelStore.loadStatus(serverId, api, null, undefined).catch(() => {});
  });


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


  const isVisible = (id: string) => settingVisible(searchQuery, settingItems, id);

  const codeIntelVisible = $derived(isVisible("code-intel") && codeIntelLanguages.length > 0);
  const typeSafeVisible = $derived(isVisible("typesafe"));
  const anyVisible = $derived(settingItems.some((s) => isVisible(s.id)) || matchingToolGroups(searchQuery).length > 0);
</script>

{#if capabilities === undefined}
  <div class="py-10 text-center text-workspace-chrome text-(--solus-text-tertiary)" role="status">
    Checking tool support…
  </div>
{:else if !isSupported}
  <SettingsHostUnsupported feature="Code intelligence tools" {hostLabel} />
{:else}
<!-- Cmd-click an identifier in a diff or file to see its definition and
     references. Each language needs its SCIP indexer on this host's PATH. -->
<SettingsSection {...settingsDefinitions["tools.section-code-intelligence"]} visible={codeIntelVisible}>
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
            class="min-w-29 transition-transform active:scale-[0.96] pointer-coarse:min-h-11"
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
{/if}

<TypeSafeKeySetting {serverId} visible={typeSafeVisible} />

<!-- Last on purpose: the tool catalog is the longest group on the page. -->
<SolusToolSettings {serverId} {searchQuery} />

{#if !anyVisible}
  <div class="py-8 text-center text-workspace-chrome text-(--solus-text-tertiary)">
    No settings match your search
  </div>
{/if}
