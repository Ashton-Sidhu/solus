<script lang="ts">
  import { untrack } from "svelte";
  import { GitBranch as GitBranchIcon } from "@lucide/svelte";
  import { getWorkspaceContext, getSessionEnvironmentStore, hosts } from "../../contexts";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { repositorySetupStore } from "../../contexts/git/repository-setup.store.svelte";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";

  interface Props {
    /** The tab or draft whose project this section describes. */
    sourceId: string;
    active: boolean;
  }
  let { sourceId, active }: Props = $props();

  const session = getWorkspaceContext();
  const environmentStore = getSessionEnvironmentStore();

  const api = $derived(session.apiFor(sourceId));
  const serverId = $derived(serverConnections.serverIdForApi(api));
  const env = $derived(environmentStore.environmentFor(session.runFor(sourceId)));
  const cwd = $derived(env.cwd);

  const status = $derived(repositorySetupStore.statusFor(serverId, cwd));
  const canWriteGit = $derived(hosts.get(serverId)?.me.may("host.git.write") ?? true);
  const showInit = $derived(!!status && !status.isRepository);

  // One repository-status read per checkout — cheap, and the manual Git
  // refresh (ProjectPanel's header button) forces a fresh one the same way.
  let requestedFor: string | null = null;
  $effect(() => {
    if (!active || !cwd || cwd === "~" || !api) return;
    const key = `${serverId}\0${cwd}`;
    if (requestedFor === key) return;
    requestedFor = key;
    untrack(() => { void repositorySetupStore.refresh(api, serverId, cwd); });
  });

  const initError = $derived(repositorySetupStore.initErrorFor(serverId, cwd));
  const initializing = $derived(repositorySetupStore.isInitializing(serverId, cwd));

  async function initializeGit() {
    if (!api) return;
    const ok = await repositorySetupStore.initialize(api, serverId, cwd);
    if (!ok) {
      toasts.error("Couldn't initialize Git", {
        description: repositorySetupStore.initErrorFor(serverId, cwd) ?? undefined,
      });
    }
    requestInputFocus();
  }
</script>

{#if showInit}
  <div class="flex flex-col gap-2 px-1 py-1">
    <p class="text-pretty text-chrome-dense leading-relaxed text-muted-foreground">
      This folder isn't a Git repository yet.
    </p>
    {#if initError}
      <p class="text-pretty text-chrome-dense leading-relaxed text-(--solus-status-error)">{initError}</p>
    {/if}
    <Button
      variant="outline"
      size="sm"
      class="w-full justify-center gap-1.5 text-chrome-dense"
      disabled={initializing || !canWriteGit}
      onclick={initializeGit}
    >
      <GitBranchIcon size={13} />
      {initializing ? "Initializing…" : "Initialize Git"}
    </Button>
  </div>
{/if}

