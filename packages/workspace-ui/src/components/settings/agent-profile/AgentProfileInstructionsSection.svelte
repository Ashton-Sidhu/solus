<script lang="ts">
  /**
   * Settings → Agent profile → Instructions: the files of each provider home
   * that are not a skill. CLAUDE.md and AGENTS.md are edited here; subagents,
   * commands, and prompts are listed and can be removed.
   */
  import { agentProfileKeyOf } from "@solus/contracts/agent-profile";
  import { agentProfileLocalStore } from "../../../contexts";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { Button } from "../../ui/button";
  import SettingsSection from "../SettingsSection.svelte";
  import SettingsRow from "../SettingsRow.svelte";
  import InstructionEditor from "./InstructionEditor.svelte";
  import { INSTRUCTION_FILES, providerLabel, type InstructionGroup } from "./lib/agent-profile-entries";

  interface Props {
    groups: InstructionGroup[];
  }

  let { groups }: Props = $props();

  function remove(key: Parameters<typeof agentProfileLocalStore.removeKey>[0]) {
    agentProfileLocalStore.removeKey(key);
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
      {#snippet control()}
        {#if group.instructions}
          <Button variant="ghost" size="sm" class="text-muted-foreground hover:text-destructive" onclick={() => remove(agentProfileKeyOf(group.instructions!))} aria-label="Remove {INSTRUCTION_FILES[group.provider]}">Remove</Button>
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
        {#snippet control()}
          <Button variant="ghost" size="sm" class="text-muted-foreground hover:text-destructive" onclick={() => remove(agentProfileKeyOf(file))} aria-label="Remove {file.path}">Remove</Button>
        {/snippet}
      </SettingsRow>
    {/each}
  </SettingsSection>
{/each}
