<script lang="ts">
  /**
   * Settings → Agent profile → Files: the files of each provider home that are
   * not a skill — subagents, commands, and prompts, copied from a computer.
   * Listed, not edited: each can be removed, which takes it off every host.
   * Nothing when the profile holds none; a long list shows a page.
   */
  import { FileCode, FileText, Trash2 } from "@lucide/svelte";
  import { agentProfileKeyOf, type AgentProfileKey } from "@solus/contracts/agent-profile";
  import { agentProfileLocalStore } from "../../../contexts";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { Button } from "../../ui/button";
  import SettingsSection from "../SettingsSection.svelte";
  import ProfileEntryRow from "./ProfileEntryRow.svelte";
  import ShowMoreRow from "./ShowMoreRow.svelte";
  import { fileRowText, pageOf, providerLabel, type FileGroup } from "./lib/agent-profile-entries";

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
  <SettingsSection label="{providerLabel(group.provider)} files · {group.files.length}" description="Subagents, commands, and prompts from your computer's home." visible={group.files.length > 0}>
    {#each page.rows as file (file.path)}
      {@const text = fileRowText(file.path, file.executable === true)}
      <ProfileEntryRow label={text.name} detail={text.detail} isPath testId="agent-profile-file-{group.provider}">
        {#snippet mark()}
          <span class="grid size-8 shrink-0 place-items-center rounded-lg border border-border/50 bg-muted text-(--solus-text-secondary)" aria-hidden="true">
            {#if file.executable}<FileCode size={15} />{:else}<FileText size={15} />{/if}
          </span>
        {/snippet}
        {#snippet action()}
          <Button variant="ghost" size="icon-sm" class="text-muted-foreground hover:text-destructive pointer-coarse:size-11" onclick={() => remove(agentProfileKeyOf(file))} aria-label="Remove {file.path}" title="Remove">
            <Trash2 size={14} />
          </Button>
        {/snippet}
      </ProfileEntryRow>
    {/each}
    <ShowMoreRow hiddenCount={page.hiddenCount} expanded={expanded[group.provider] === true} noun="files" onToggle={() => toggleExpanded(group.provider)} />
  </SettingsSection>
{/each}
