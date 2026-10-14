<script module lang="ts">
  /** Search words, read by the settings page to find this page from any other. */
  export const searchWords = ["agent profile", "profile", "instructions", "extra", "system prompt", "custom", "subagents", "commands", "prompts", "skills", "mcp", "servers", "conflict"];
</script>

<script lang="ts">
  /**
   * Settings → Agent profile (plans/020-agent-profile.md §3): the person's
   * instructions (a personal setting every prompt carries), and their skills,
   * MCP servers, and copied files as one document, edited here on this
   * client's local copy. The account's sync, the hosts, and the clear are on
   * Settings → Account & sync; an entry two devices changed is resolved here,
   * beside the content. The page needs no host: it reads this device's copy,
   * and asks a host only to search skills or check a server address. On the
   * desktop, this computer's own skills, files, and MCP servers fill an empty
   * copy when the page opens, and join it again on "Import from this computer".
   */
  import { untrack } from "svelte";
  import { LoaderCircle, HardDriveDownload } from "@lucide/svelte";
  import { agentProfileLocalStore, agentProfileStore, hosts } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import SettingsSection from "./SettingsSection.svelte";
  import { settingsHost } from "./lib/settings-host.svelte";
  import { sectionsOf } from "./agent-profile/lib/agent-profile-entries";
  import AgentProfileConflictsSection from "./agent-profile/AgentProfileConflictsSection.svelte";
  import AgentProfileInstructionsSection from "./agent-profile/AgentProfileInstructionsSection.svelte";
  import AgentProfileFilesSection from "./agent-profile/AgentProfileFilesSection.svelte";
  import AgentProfileSkillsSection from "./agent-profile/AgentProfileSkillsSection.svelte";
  import AgentProfileServersSection from "./agent-profile/AgentProfileServersSection.svelte";

  let { searchQuery = "" }: { searchQuery?: string } = $props();

  const sections = $derived(sectionsOf(agentProfileLocalStore.entries));
  // A registry search or an address check runs on the host Settings shows, else the device, else the Run on host.
  const settingsToolHost = $derived(hosts.get(settingsHost.serverId));
  const toolHost = $derived(settingsToolHost?.presence === "present" ? settingsToolHost : hosts.device ?? hosts.runOn);
  const isVisible = $derived(!searchQuery || searchWords.some((keyword) => keyword.toLowerCase().includes(searchQuery.toLowerCase())));

  // The page opened on a desktop: an empty copy fills from this computer, so the person's skills and servers are already here.
  $effect(() => untrack(() => agentProfileStore.importComputerIfEmpty()));

  async function importComputer() {
    await agentProfileStore.importComputer();
    requestInputFocus();
  }
</script>

{#if isVisible}
  <div class="flex flex-col gap-8">
    <SettingsSection
      label="This computer"
      description="Your profile starts from this computer: its skills, subagents, commands, prompts, and MCP servers. Import again to add what you installed since. Nothing is removed from the profile; remove or disable an entry here."
      visible={agentProfileStore.canCopy}
      plain
    >
      {#snippet action()}
        <Button variant="outline" size="sm" class="[@media(pointer:coarse)]:min-h-11" disabled={agentProfileStore.importing} onclick={() => void importComputer()} data-testid="agent-profile-import">
          {#if agentProfileStore.importing}<LoaderCircle size={14} class="animate-spin motion-reduce:animate-none" />Reading…{:else}<HardDriveDownload size={14} />Import from this computer{/if}
        </Button>
      {/snippet}
      {#if agentProfileStore.importError}
        <p role="alert" class="text-chrome-dense text-(--solus-status-error)">Solus could not read this computer's profile: {agentProfileStore.importError}</p>
      {/if}
    </SettingsSection>
    <AgentProfileConflictsSection />
    <AgentProfileInstructionsSection />
    <AgentProfileSkillsSection registrySkills={sections.registrySkills} writtenSkills={sections.writtenSkills} searchHostId={toolHost?.id ?? null} />
    <AgentProfileServersSection integrations={sections.integrations} probeHostId={toolHost?.id ?? null} />
    <AgentProfileFilesSection groups={sections.files} />
  </div>
{/if}
