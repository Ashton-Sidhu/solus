<script lang="ts">
  import { sessionSettings as settingItems } from "./lib/settings-search-data";
  import { PERMISSION_MODES } from "@solus/contracts/types";
  import { PROVIDERS } from "@solus/contracts/provider-model-settings";
  import { PERMISSION_MODE_DISPLAY } from "../../lib/permission-modes";
  import { getSettingsContext, getWorkspaceContext } from "../../contexts";
  import { Switch } from "../ui/switch";
  import SettingsSelect from "./SettingsSelect.svelte";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import { managedSetting } from "./policy/managed-setting.svelte";
  import RateLimitSetting from "./RateLimitSetting.svelte";
  import ModelRoutingSection from "./ModelRoutingSection.svelte";
  import LeadSessionsSection from "./LeadSessionsSection.svelte";
  let { searchQuery = "", serverId }: { searchQuery?: string; serverId?: string } = $props();
  const theme = getSettingsContext();
  const session = getWorkspaceContext();
  const permissionModes = PERMISSION_MODES.map((value) => ({ value, label: PERMISSION_MODE_DISPLAY[value].label }));
  function isVisible(id: string): boolean {
    if (!searchQuery) return true;
    return settingItems.find((item) => item.id === id)?.keywords.some((word) => word.includes(searchQuery.toLowerCase())) ?? false;
  }
</script>

<SettingsSection
  label="New sessions"
  visible={["agent-model", "default-permission"].some(isVisible)}
>
  <SettingsRow label="Default provider" description="Provider for new sessions. Set each provider's model in Providers." visible={isVisible("agent-model")}>
    {#snippet control()}
      <SettingsSelect options={PROVIDERS.map((provider) => ({ value: provider.id, label: provider.label }))} value={theme.activeAgent} onSelect={(value) => session.config.setDefaultAgent(value)} ariaLabel="Default provider" />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Default permission mode"
    managed={managedSetting("defaultPermissionMode")}
    description="Mode for new sessions. Existing sessions keep theirs."
    visible={isVisible("default-permission")}
  >
    {#snippet control()}
      <SettingsSelect
        options={permissionModes}
        value={theme.defaultPermissionMode}
        onSelect={(value) => theme.setPersonal("defaultPermissionMode", value)}
        ariaLabel="Default permission mode"
      />
    {/snippet}
  </SettingsRow>
</SettingsSection>

{#if serverId}<ModelRoutingSection {serverId} visible={isVisible("model-routing")} />{/if}

<LeadSessionsSection {isVisible} />

<SettingsSection label="Sessions" visible={["auto-rename", "ratelimit"].some(isVisible)}>
  <SettingsRow
    label="Name sessions automatically"
    description="Summarize the first prompt into a short session name."
    visible={isVisible("auto-rename")}
  >
    {#snippet control()}
      <Switch
        checked={theme.autoRenameSessions}
        onCheckedChange={(next) => theme.setPersonal("autoRenameSessions", next)}
        size="default"
        aria-label="Toggle automatic session naming"
      />
    {/snippet}
  </SettingsRow>

  <RateLimitSetting visible={isVisible("ratelimit")} />
</SettingsSection>
