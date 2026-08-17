<script lang="ts">
  import { GitBranchIcon, GithubLogoIcon } from "phosphor-svelte";
  import { getWorkspaceContext, getSessionEnvironmentStore } from "../../contexts";
  import { serverConnections } from "@client-core/server-connections";
  import { repositorySetupStore } from "../../contexts/git/repository-setup.store.svelte";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import PublishRepositoryDialog from "./publish-repository/PublishRepositoryDialog.svelte";

  interface Props {
    /** The tab or draft whose project this section describes. */
    sourceId: string;
  }
  let { sourceId }: Props = $props();

  const session = getWorkspaceContext();
  const environmentStore = getSessionEnvironmentStore();

  const api = $derived(session.apiFor(sourceId));
  const serverId = $derived(serverConnections.serverIdForApi(api));
  const env = $derived(environmentStore.environmentFor(session.runFor(sourceId)));
  const cwd = $derived(env.cwd);
  const ctx = $derived(session.ctxForEnvironment(env.cwd, env.checkout, sourceId));

  const status = $derived(repositorySetupStore.statusFor(serverId, cwd));
  const showInit = $derived(!!status && !status.isRepository);
  // Publishing normally belongs to the Git rows' pull-request row. This card is
  // only for the stage before those rows exist: a repository whose HEAD is
  // still unborn reports no branch, so nothing else offers a way forward.
  const showPublish = $derived(
    !!status && status.isRepository && !status.hasCommits && !status.primaryRemoteUrl,
  );

  // One repository-status read per checkout — cheap, and the manual Git
  // refresh (ProjectPanel's header button) forces a fresh one the same way.
  let requestedFor = $state<string | null>(null);
  $effect(() => {
    if (!cwd || cwd === "~" || !api) return;
    const key = `${serverId}\0${cwd}`;
    if (requestedFor === key) return;
    requestedFor = key;
    void repositorySetupStore.refresh(api, serverId, cwd);
  });

  let checkedConnectionFor = $state<string | null>(null);
  $effect(() => {
    if (!showPublish || !api) return;
    const key = `${serverId}\0${cwd}`;
    if (checkedConnectionFor === key) return;
    checkedConnectionFor = key;
    void repositorySetupStore.refreshGithubConnection(api, serverId, ctx, cwd);
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

  let publishDialogOpen = $state(false);

  function closePublishDialog() {
    publishDialogOpen = false;
    requestInputFocus();
  }
</script>

{#if showInit}
  <div class="flex flex-col gap-2 px-1 py-1">
    <p class="text-pretty text-xs leading-relaxed text-muted-foreground">
      This folder isn't a Git repository yet.
    </p>
    {#if initError}
      <p class="text-pretty text-xs leading-relaxed text-(--solus-status-error)">{initError}</p>
    {/if}
    <Button
      variant="outline"
      size="sm"
      class="w-full justify-center gap-1.5 text-[0.8125rem]"
      disabled={initializing}
      onclick={initializeGit}
    >
      <GitBranchIcon size={13} />
      {initializing ? "Initializing…" : "Initialize Git"}
    </Button>
  </div>
{:else if showPublish}
  <div class="flex flex-col gap-2 px-1 py-1">
    <p class="text-pretty text-xs leading-relaxed text-muted-foreground">
      No commits yet — publishing creates the GitHub repository and its remote.
    </p>
    <Button
      variant="outline"
      size="sm"
      class="w-full justify-center gap-1.5 text-[0.8125rem]"
      onclick={() => (publishDialogOpen = true)}
    >
      <GithubLogoIcon size={13} />
      Publish to GitHub
    </Button>
  </div>
{/if}

{#if publishDialogOpen}
  <PublishRepositoryDialog {sourceId} onClose={closePublishDialog} />
{/if}
