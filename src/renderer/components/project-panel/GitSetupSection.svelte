<script lang="ts">
  import { GitBranchIcon, GithubLogoIcon } from "phosphor-svelte";
  import { getWorkspaceContext, getSessionEnvironmentStore } from "../../contexts";
  import { serverConnections } from "@client-core/server-connections";
  import { repositorySetupStore } from "../../contexts/git/repository-setup.store.svelte";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { Switch } from "../ui/switch";
  import GithubConnectionRequired from "../prs/GithubConnectionRequired.svelte";
  import {
    publishFailureMessage,
    publishFailureStage,
    publishRepositoryUrl,
    repoNameFromCwd,
  } from "./lib/git-setup";

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
  const showPublish = $derived(!!status && status.isRepository && !status.primaryRemoteUrl);

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

  let githubConnected = $state<boolean | null>(null);
  let checkedConnectionFor = $state<string | null>(null);
  $effect(() => {
    if (!showPublish || !api) return;
    const key = `${serverId}\0${cwd}`;
    if (checkedConnectionFor === key) return;
    checkedConnectionFor = key;
    void api
      .providerStatus(ctx)
      .then((result) => (githubConnected = result.connected))
      .catch(() => (githubConnected = false));
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

  // --- Publish form -----------------------------------------------------
  let formOpen = $state(false);
  let owner = $state("");
  let name = $state("");
  let isPrivate = $state(true);
  let useSsh = $state(false);
  let ownerPrefilled = $state(false);

  $effect(() => {
    if (!formOpen || ownerPrefilled || !api) return;
    ownerPrefilled = true;
    if (!name) name = repoNameFromCwd(cwd);
    void api.providerViewer(ctx).then((login) => {
      if (!owner) owner = login;
    }).catch(() => {});
  });

  function openForm() {
    formOpen = true;
    repositorySetupStore.clearPublishResult(serverId, cwd);
  }

  function closeForm() {
    formOpen = false;
    requestInputFocus();
  }

  const publishing = $derived(repositorySetupStore.isPublishing(serverId, cwd));
  const publishError = $derived(repositorySetupStore.publishErrorFor(serverId, cwd));
  const lastResult = $derived(repositorySetupStore.lastPublishResultFor(serverId, cwd));
  const lastFailureMessage = $derived(lastResult ? publishFailureMessage(lastResult) : null);
  const lastRepositoryUrl = $derived(lastResult ? publishRepositoryUrl(lastResult) : null);
  const lastFailureStage = $derived(lastResult ? publishFailureStage(lastResult) : null);

  async function submitPublish() {
    if (!api || !owner.trim() || !name.trim() || publishing) return;
    const result = await repositorySetupStore.publish(api, serverId, ctx, cwd, {
      owner: owner.trim(),
      name: name.trim(),
      private: isPrivate,
      protocol: useSsh ? "ssh" : "https",
    });
    if (result?.success) {
      toasts.success("Published to GitHub");
      formOpen = false;
      requestInputFocus();
    } else if (!result) {
      toasts.error("Couldn't publish to GitHub", { description: publishError ?? undefined });
    }
  }

  function openRepositoryUrl(url: string) {
    void session.apiFor(sourceId).openExternal(url);
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
    {#if githubConnected === false}
      <GithubConnectionRequired {serverId} />
    {:else if !formOpen}
      {#if lastResult && !lastResult.success}
        <p class="text-pretty text-xs leading-relaxed text-(--solus-status-error)">
          {lastFailureStage === "repository"
            ? "Couldn't create the repository"
            : lastFailureStage === "remote"
              ? "Repository created, but adding the remote failed"
              : "Repository created, but the push failed"}{lastFailureMessage ? `: ${lastFailureMessage}` : "."}
        </p>
        {#if lastRepositoryUrl}
          <button
            type="button"
            class="truncate text-left text-xs text-(--solus-accent) hover:underline"
            onclick={() => openRepositoryUrl(lastRepositoryUrl!)}
          >
            {lastRepositoryUrl}
          </button>
        {/if}
        <Button
          variant="outline"
          size="sm"
          class="w-full justify-center gap-1.5 text-[0.8125rem]"
          disabled={publishing}
          onclick={submitPublish}
        >
          {publishing ? "Retrying…" : "Retry"}
        </Button>
      {:else}
        <Button
          variant="outline"
          size="sm"
          class="w-full justify-center gap-1.5 text-[0.8125rem]"
          onclick={openForm}
        >
          <GithubLogoIcon size={13} />
          Publish to GitHub
        </Button>
      {/if}
    {:else}
      <label class="flex flex-col gap-1">
        <span class="text-menu-meta text-muted-foreground">Owner</span>
        <Input bind:value={owner} class="h-7 text-xs" spellcheck={false} autocomplete="off" />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-menu-meta text-muted-foreground">Repository name</span>
        <Input bind:value={name} class="h-7 text-xs" spellcheck={false} autocomplete="off" />
      </label>
      <div class="flex items-center justify-between gap-2 py-0.5">
        <span class="text-xs text-muted-foreground">Private repository</span>
        <Switch checked={isPrivate} onCheckedChange={(next) => (isPrivate = next)} size="default" aria-label="Private repository" />
      </div>
      <div class="flex items-center justify-between gap-2 py-0.5">
        <span class="text-xs text-muted-foreground">Use SSH</span>
        <Switch checked={useSsh} onCheckedChange={(next) => (useSsh = next)} size="default" aria-label="Publish over SSH" />
      </div>
      {#if publishError}
        <p class="text-pretty text-xs leading-relaxed text-(--solus-status-error)">{publishError}</p>
      {/if}
      <div class="flex items-center gap-2 pt-1">
        <Button variant="ghost" size="sm" class="flex-1 text-[0.8125rem]" onclick={closeForm}>Cancel</Button>
        <Button
          size="sm"
          class="flex-1 text-[0.8125rem]"
          disabled={publishing || !owner.trim() || !name.trim()}
          onclick={submitPublish}
        >
          {publishing ? "Publishing…" : "Publish"}
        </Button>
      </div>
    {/if}
  </div>
{/if}
