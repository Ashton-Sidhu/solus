<script lang="ts">
  /**
   * Settings → Agent profile → Files: the files of each provider home that are
   * not a skill — subagents, commands, and prompts, copied from a computer.
   * Listed, not edited: each can be removed, or turned off on every host and
   * kept in the profile. Nothing when the profile holds none.
   */
  import { agentProfileKeyOf, type AgentProfileKey } from "@solus/contracts/agent-profile";
  import { agentProfileLocalStore } from "../../../contexts";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { Button } from "../../ui/button";
  import SettingsSection from "../SettingsSection.svelte";
  import SettingsRow from "../SettingsRow.svelte";
  import { entriesWithDisabled, providerLabel, type FileGroup } from "./lib/agent-profile-entries";

  interface Props {
    groups: FileGroup[];
  }

  let { groups }: Props = $props();

  function remove(key: AgentProfileKey) {
    agentProfileLocalStore.removeKey(key);
    requestInputFocus();
  }

  function setDisabled(key: AgentProfileKey, disabled: boolean) {
    agentProfileLocalStore.setEntry(...entriesWithDisabled(agentProfileLocalStore.storedEntries, [key], disabled));
    requestInputFocus();
  }
</script>

{#each groups as group (group.provider)}
  <SettingsSection label="{providerLabel(group.provider)} files" description="Subagents, commands, and prompts from your computer's home." visible={group.files.length > 0}>
    {#each group.files as file (file.path)}
      <SettingsRow label={file.path} description={file.executable ? "Executable" : undefined} testId="agent-profile-file-{group.provider}">
        {#snippet labelExtra()}
          {#if file.disabled}<span class="ml-2 text-chrome-dense text-muted-foreground">Off on every host</span>{/if}
        {/snippet}
        {#snippet control()}
          <span class="flex gap-1.5">
            <Button variant="ghost" size="sm" onclick={() => setDisabled(agentProfileKeyOf(file), !file.disabled)} aria-label="{file.disabled ? 'Enable' : 'Disable'} {file.path}">{file.disabled ? "Enable" : "Disable"}</Button>
            <Button variant="ghost" size="sm" class="text-muted-foreground hover:text-destructive" onclick={() => remove(agentProfileKeyOf(file))} aria-label="Remove {file.path}">Remove</Button>
          </span>
        {/snippet}
      </SettingsRow>
    {/each}
  </SettingsSection>
{/each}
