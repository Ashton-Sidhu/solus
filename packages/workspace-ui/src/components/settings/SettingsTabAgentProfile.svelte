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
   * desktop, this computer's own skills, files, and MCP servers join the copy
   * only on "Import from this computer": the profile never fills by itself.
   */
  import { LoaderCircle, HardDriveDownload, Laptop } from "@lucide/svelte";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { agentProfileLocalStore, agentProfileStore, hosts, serversStore } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
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
  const toolHostLabel = $derived.by(() => {
    const id = toolHost?.id;
    if (!id) return "this host";
    return serversStore.hostFor(id)?.label ?? serverConnections.connectionFor(id)?.target.label ?? "this host";
  });
  const isVisible = $derived(!searchQuery || searchWords.some((keyword) => keyword.toLowerCase().includes(searchQuery.toLowerCase())));

  async function importComputer() {
    await agentProfileStore.importComputer();
    requestInputFocus();
  }
</script>

{#if isVisible}
  <div class="flex flex-col gap-8">
    {#if agentProfileStore.canCopy}
      <section class="flex flex-col gap-3 rounded-xl border border-border/50 bg-muted/30 px-4 py-3.5" aria-label="This computer">
        <div class="flex min-w-0 flex-wrap items-center gap-3">
          <span class="grid size-8 shrink-0 place-items-center rounded-lg border border-border/50 bg-background text-(--solus-text-secondary)" aria-hidden="true"><Laptop size={15} /></span>
          <div class="flex min-w-0 flex-1 flex-col">
            <h2 class="text-workspace-chrome font-medium text-foreground">Import from this computer</h2>
            <p class="text-pretty text-chrome-dense text-(--solus-text-secondary)">Adds this computer's skills, subagents, commands, prompts, and MCP servers. Import again to add new ones. An import removes nothing.</p>
          </div>
          <Button variant="outline" size="sm" class="shrink-0 text-workspace-chrome shadow-xs pointer-coarse:min-h-11" disabled={agentProfileStore.importing} onclick={() => void importComputer()} data-testid="agent-profile-import">
            {#if agentProfileStore.importing}<LoaderCircle size={14} class="animate-spin motion-reduce:animate-none" />Reading…{:else}<HardDriveDownload size={14} />Import{/if}
          </Button>
        </div>
        {#if agentProfileStore.importError}
          <p role="alert" class="pl-11 text-chrome-dense text-(--solus-status-error)">Solus could not read this computer's profile: {agentProfileStore.importError}</p>
        {/if}
      </section>
    {/if}
    <AgentProfileConflictsSection />
    <AgentProfileInstructionsSection />
    <AgentProfileSkillsSection registrySkills={sections.registrySkills} writtenSkills={sections.writtenSkills} searchHostId={toolHost?.id ?? null} />
    <AgentProfileServersSection integrations={sections.integrations} probeHostId={toolHost?.id ?? null} hostLabel={toolHostLabel} />
    <AgentProfileFilesSection groups={sections.files} />
  </div>
{/if}
