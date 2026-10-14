<script lang="ts">
  /**
   * Settings → Agent profile → Instructions: the files of each provider home
   * that are not a skill. CLAUDE.md and AGENTS.md are edited here; subagents,
   * commands, and prompts are listed. Each can be removed, or turned off on
   * every host and kept in the profile.
   */
  import { agentProfileKeyOf, type AgentProfileKey } from "@solus/contracts/agent-profile";
  import { agentProfileLocalStore } from "../../../contexts";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { Button } from "../../ui/button";
  import SettingsSection from "../SettingsSection.svelte";
  import SettingsRow from "../SettingsRow.svelte";
  import InstructionEditor from "./InstructionEditor.svelte";
  import { entriesWithDisabled, INSTRUCTION_FILES, providerLabel, type InstructionGroup } from "./lib/agent-profile-entries";

  interface Props {
    groups: InstructionGroup[];
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
  <SettingsSection label="{providerLabel(group.provider)} instructions">
    <SettingsRow
      label={INSTRUCTION_FILES[group.provider]}
      description={group.instructions ? "Read first by every agent in your seats and on hosts you own." : "Not in your profile yet. Write it here."}
      testId="agent-profile-instructions-{group.provider}"
    >
      {#snippet labelExtra()}
        {#if group.instructions?.disabled}<span class="ml-2 text-chrome-dense text-muted-foreground">Off on every host</span>{/if}
      {/snippet}
      {#snippet control()}
        {#if group.instructions}
          {@const instructions = group.instructions}
          <span class="flex gap-1.5">
            <Button variant="ghost" size="sm" onclick={() => setDisabled(agentProfileKeyOf(instructions), !instructions.disabled)} aria-label="{instructions.disabled ? 'Enable' : 'Disable'} {INSTRUCTION_FILES[group.provider]}">{instructions.disabled ? "Enable" : "Disable"}</Button>
            <Button variant="ghost" size="sm" class="text-muted-foreground hover:text-destructive" onclick={() => remove(agentProfileKeyOf(instructions))} aria-label="Remove {INSTRUCTION_FILES[group.provider]}">Remove</Button>
          </span>
        {/if}
      {/snippet}
      {#snippet body()}
        {#key group.instructions?.hash ?? ""}
          <InstructionEditor provider={group.provider} path={INSTRUCTION_FILES[group.provider]} entry={group.instructions} />
        {/key}
      {/snippet}
    </SettingsRow>
    {#each group.otherFiles as file (file.path)}
      <SettingsRow label={file.path} description={file.executable ? "Executable" : undefined}>
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
