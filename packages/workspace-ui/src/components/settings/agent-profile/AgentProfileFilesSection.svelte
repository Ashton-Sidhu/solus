<script lang="ts">
  /**
   * Settings → Agent profile → Files: the files of each provider home that are
   * not a skill — subagents, commands, and prompts, copied from a computer.
   * Listed, not edited: each can be removed, which takes it off every host.
   * Nothing when the profile holds none; a long list shows a page.
   */
  import { agentProfileKeyOf, type AgentProfileKey } from "@solus/contracts/agent-profile";
  import { agentProfileLocalStore } from "../../../contexts";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { Button } from "../../ui/button";
  import SettingsSection from "../SettingsSection.svelte";
  import SettingsRow from "../SettingsRow.svelte";
  import ShowMoreRow from "./ShowMoreRow.svelte";
  import { pageOf, providerLabel, type FileGroup } from "./lib/agent-profile-entries";

  interface Props {
    groups: FileGroup[];
  }

  let { groups }: Props = $props();

  function remove(key: AgentProfileKey) {
    agentProfileLocalStore.removeKey(key);
    requestInputFocus();
  }

  // One fold per provider group.
  let expanded = $state<Record<string, boolean>>({});

  function toggleExpanded(provider: string) {
    expanded[provider] = !expanded[provider];
    requestInputFocus();
  }
</script>

{#each groups as group (group.provider)}
  {@const page = pageOf(group.files, expanded[group.provider] === true)}
  <SettingsSection label="{providerLabel(group.provider)} files" description="Subagents, commands, and prompts from your computer's home." visible={group.files.length > 0}>
    {#each page.rows as file (file.path)}
      <SettingsRow label={file.path} description={file.executable ? "Executable" : undefined} testId="agent-profile-file-{group.provider}">
        {#snippet control()}
          <Button variant="ghost" size="sm" class="text-muted-foreground hover:text-destructive" onclick={() => remove(agentProfileKeyOf(file))} aria-label="Remove {file.path}">Remove</Button>
        {/snippet}
      </SettingsRow>
    {/each}
    <ShowMoreRow hiddenCount={page.hiddenCount} expanded={expanded[group.provider] === true} noun="files" onToggle={() => toggleExpanded(group.provider)} />
  </SettingsSection>
{/each}
