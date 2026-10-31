<script lang="ts">
  import { untrack } from "svelte";
  import type { HostApi } from "@solus/client-core/host-api";
  import { getWorkspaceContext, projectsStore } from "../../contexts";
  import { settingsProjectChoices } from "./lib/settings-scope";
  import ProjectChip from "../input/ProjectChip.svelte";
  import { openFolder } from "../../contexts/workspace/run-location";
  let { serverId, api, projectCwd, onSelect, onHostSelect }: { serverId: string; api: HostApi; projectCwd: string | null; onSelect: (cwd: string | null) => void; onHostSelect: (serverId: string) => void } = $props();
  const session = getWorkspaceContext();
  let error = $state("");
  const scopeRun = $derived({ ...session.defaultRunConfig, location: openFolder(session.defaultRunConfig.location, { serverId, path: projectCwd ?? "~" }) });
  const projects = $derived(projectsStore.projectsFor(serverId));
  const choices = $derived(settingsProjectChoices(projects, projectCwd));
  $effect(() => {
    const hostId = serverId;
    const hostApi = api;
    let current = true;
    untrack(() => {
      error = "";
      void projectsStore.loadProjectsFor(hostId, hostApi).then(() => { if (current && !projectsStore.projectsLoadedFor(hostId)) error = "Could not load projects. Reopen this page to try again."; });
    });
    return () => { current = false; };
  });
</script>

<span class="flex min-w-0 flex-wrap items-center gap-2">
  <span>Applying settings for</span>
  <ProjectChip run={scopeRun} projectDir={projectCwd ?? ""} label={choices.find((choice) => choice.value === (projectCwd ?? ""))?.label ?? "All projects"}
    onSelect={(checkout) => { if (checkout.serverId !== serverId) onHostSelect(checkout.serverId); onSelect(checkout.projectRoot); }}
    onAllProjects={() => onSelect(null)} onDismiss={() => {}} />
  {#if error}<span role="status">{error}</span>{/if}
</span>
