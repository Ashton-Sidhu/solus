<script module lang="ts">
  /** Search words, read by the settings page to find this page from any other. */
  export const searchWords = ["agent profile", "profile", "instructions", "CLAUDE.md", "AGENTS.md", "skills", "mcp", "servers", "conflict"];
</script>

<script lang="ts">
  /**
   * Settings → Agent profile (plans/020-agent-profile.md §3): the person's
   * instructions, skills, and MCP servers as one document, edited here on this
   * client's local copy. The account's sync, the hosts, and the clear are on
   * Settings → Account & sync; an entry two devices changed is resolved here,
   * beside the content. The page needs no host: it reads this device's copy,
   * and asks a host only to search skills or check a server address.
   */
  import { agentProfileLocalStore, hosts } from "../../contexts";
  import { settingsHost } from "./lib/settings-host.svelte";
  import { sectionsOf } from "./agent-profile/lib/agent-profile-entries";
  import AgentProfileConflictsSection from "./agent-profile/AgentProfileConflictsSection.svelte";
  import AgentProfileInstructionsSection from "./agent-profile/AgentProfileInstructionsSection.svelte";
  import AgentProfileSkillsSection from "./agent-profile/AgentProfileSkillsSection.svelte";
  import AgentProfileServersSection from "./agent-profile/AgentProfileServersSection.svelte";

  let { searchQuery = "" }: { searchQuery?: string } = $props();

  const sections = $derived(sectionsOf(agentProfileLocalStore.entries));
  // A registry search or an address check runs on the host Settings shows, else the device, else the Run on host.
  const settingsToolHost = $derived(hosts.get(settingsHost.serverId));
  const toolHost = $derived(settingsToolHost?.presence === "present" ? settingsToolHost : hosts.device ?? hosts.runOn);
  const isVisible = $derived(!searchQuery || searchWords.some((keyword) => keyword.toLowerCase().includes(searchQuery.toLowerCase())));
</script>

{#if isVisible}
  <div class="flex flex-col gap-8">
    <AgentProfileConflictsSection />
    <AgentProfileInstructionsSection groups={sections.instructions} />
    <AgentProfileSkillsSection registrySkills={sections.registrySkills} writtenSkills={sections.writtenSkills} searchHostId={toolHost?.id ?? null} />
    <AgentProfileServersSection integrations={sections.integrations} probeHostId={toolHost?.id ?? null} />
  </div>
{/if}
