<script lang="ts">
  /** The organization's projects in Solus Cloud (docs/plans/project-model.md
   *  §2): one row per repository, the settings every member shares, and the
   *  machines that hold a checkout. Rendered only when the account holds a
   *  workspace; a host's own folders stay in the list below. */
  import { Trash2 as TrashIcon, Check as CheckIcon, X as XIcon } from "@lucide/svelte";
  import { projectsStore, serversStore, workspaceProjectsStore } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import SettingsSection from "./SettingsSection.svelte";
  import { checkoutHostsOf, cloudProjectSuggestions } from "./lib/cloud-projects";

  const cloudServerId = $derived(serversStore.activeCloudServerId);
  const online = $derived(!!cloudServerId && serversStore.statusFor(cloudServerId) === "online");
  const projects = $derived(workspaceProjectsStore.projectsFor(cloudServerId));
  const suggestions = $derived(cloudProjectSuggestions(projectsStore.entries, projects));

  let repositoryInput = $state("");
  let confirmingRemoval = $state<string | null>(null);

  async function run(action: () => Promise<unknown>, failure: string) {
    try {
      await action();
    } catch (error) {
      toasts.error(failure, { description: error instanceof Error ? error.message : String(error) });
    }
  }

  function add(repositoryKey: string) {
    if (!cloudServerId || !repositoryKey.trim()) return;
    void run(async () => {
      await workspaceProjectsStore.add(cloudServerId, repositoryKey.trim());
      repositoryInput = "";
    }, "Couldn't add the project to Solus Cloud");
  }

  function save(projectId: string, patch: { displayName?: string; defaultBranch?: string | null }) {
    if (!cloudServerId) return;
    void run(() => workspaceProjectsStore.update(cloudServerId, projectId, patch), "Couldn't save the project");
  }

  function remove(projectId: string) {
    if (!cloudServerId) return;
    confirmingRemoval = null;
    void run(() => workspaceProjectsStore.remove(cloudServerId, projectId), "Couldn't remove the project");
  }

  function hostLabel(serverId: string): string {
    return serversStore.hostFor(serverId)?.label ?? serverId;
  }
</script>

<SettingsSection
  label="Solus Cloud projects"
  description="All members see these projects and PRs. Only tasks made on a Cloud host are shared."
  visible={!!cloudServerId}
>
  {#if !online}
    <p class="px-4 py-3 text-sm text-muted-foreground">Solus Cloud is not connected. The list shows what it last said.</p>
  {/if}
  {#each projects as project (project.id)}
    {@const hosts = checkoutHostsOf(project, projectsStore.entries)}
    <div class="flex flex-col gap-2 px-4 py-3">
      <div class="flex items-center gap-2">
        <Input
          class="h-8 max-w-64"
          value={project.displayName}
          aria-label="Project name"
          disabled={!online}
          onchange={(event) => save(project.id, { displayName: event.currentTarget.value })}
        />
        <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{project.repositoryKey}</span>
        {#if confirmingRemoval === project.id}
          <Button variant="ghost" size="icon-sm" aria-label="Confirm remove" onclick={() => remove(project.id)}>
            <CheckIcon size={13} />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Cancel remove" onclick={() => (confirmingRemoval = null)}>
            <XIcon size={13} />
          </Button>
        {:else}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Remove {project.displayName} from Solus Cloud"
            disabled={!online}
            onclick={() => (confirmingRemoval = project.id)}
          >
            <TrashIcon size={14} />
          </Button>
        {/if}
      </div>
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <label class="text-muted-foreground" for="default-branch-{project.id}">New worktrees start from</label>
        <Input
          id="default-branch-{project.id}"
          class="h-8 w-40"
          placeholder="the repository default"
          value={project.defaultBranch ?? ""}
          disabled={!online}
          onchange={(event) => save(project.id, { defaultBranch: event.currentTarget.value || null })}
        />
      </div>
      <p class="text-xs text-muted-foreground">
        {hosts.length > 0
          ? `Checkouts on ${hosts.map(hostLabel).join(", ")}`
          : "No machine you have connected holds a checkout. The Cloud host clones it when a session needs it."}
      </p>
    </div>
  {/each}
  <form
    class="flex flex-col gap-2 px-4 py-3"
    onsubmit={(event) => {
      event.preventDefault();
      add(repositoryInput);
    }}
  >
    <div class="flex items-center gap-2">
      <Input
        class="h-8 flex-1"
        placeholder="github.com/owner/repo or a clone URL"
        aria-label="Repository to add"
        bind:value={repositoryInput}
        disabled={!online}
      />
      <Button type="submit" size="sm" disabled={!online || !repositoryInput.trim()}>Add project</Button>
    </div>
    {#if suggestions.length > 0}
      <div class="flex flex-wrap items-center gap-1.5">
        <span class="text-xs text-muted-foreground">From your machines:</span>
        {#each suggestions as suggestion (suggestion.repositoryKey)}
          <Button variant="outline" size="sm" disabled={!online} onclick={() => add(suggestion.repositoryKey)}>
            {suggestion.label}
          </Button>
        {/each}
      </div>
    {/if}
  </form>
</SettingsSection>
