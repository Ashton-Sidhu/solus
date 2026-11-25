<script lang="ts">
  import { settingVisible } from "@solus/client-core/settings-search";
  import { settingsDefinitions } from "@solus/client-core/settings-definitions";
  import { sessionSettings as settingItems } from "./lib/settings-search-data";
  import { PERMISSION_MODES } from "@solus/contracts/types";
  import { PROVIDERS } from "@solus/contracts/provider-model-settings";
  import { PERMISSION_MODE_DISPLAY } from "../../lib/permission-modes";
  import { getSettingsContext, getWorkspaceContext } from "../../contexts";
  import SettingsSelect from "./SettingsSelect.svelte";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import { managedSetting } from "./policy/managed-setting.svelte";
  import RateLimitSetting from "./RateLimitSetting.svelte";
  import ModelRoutingSection from "./ModelRoutingSection.svelte";
  import DelegationSettingsSection from "./DelegationSettingsSection.svelte";
  let { searchQuery = "", serverId }: { searchQuery?: string; serverId?: string } = $props();
  const theme = getSettingsContext();
  const session = getWorkspaceContext();
  const permissionModes = PERMISSION_MODES.map((value) => ({ value, label: PERMISSION_MODE_DISPLAY[value].label }));
  const isVisible = (id: string) => settingVisible(searchQuery, settingItems, id);
</script>

<SettingsSection
  {...settingsDefinitions["sessions.section-new-sessions"]}
  visible={["agent-model", "default-permission"].some(isVisible)}
>
  <SettingsRow {...settingsDefinitions["sessions.agent-model"]} visible={isVisible("agent-model")}>
    {#snippet control()}
      <SettingsSelect options={PROVIDERS.map((provider) => ({ value: provider.id, label: provider.label }))} value={theme.activeAgent} onSelect={(value) => session.config.setDefaultAgent(value)} ariaLabel="Default provider" />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    {...settingsDefinitions["sessions.default-permission"]}
    managed={managedSetting("defaultPermissionMode")}
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

<DelegationSettingsSection {isVisible} />

<SettingsSection {...settingsDefinitions["sessions.section-sessions"]} visible={isVisible("ratelimit")}>
  <RateLimitSetting visible={isVisible("ratelimit")} />
</SettingsSection>
