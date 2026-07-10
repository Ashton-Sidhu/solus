<script lang="ts">
  import { onMount } from "svelte";
  import {
    ArrowClockwiseIcon,
    CaretDownIcon,
    CheckCircleIcon,
    CircleIcon,
    DownloadSimpleIcon,
    GitBranchIcon,
    PencilSimpleIcon,
    SpinnerGapIcon,
    WarningCircleIcon,
  } from "phosphor-svelte";
  import { connectionsStore } from "../../contexts/connections.store.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import GitHubConnect from "../connections/GitHubConnect.svelte";
  import { serverSetupStore } from "./server-setup.store.svelte";
  import {
    hasSetupGaps,
    setupStepIdsForCapabilities,
    type SetupChecklistStepId,
  } from "./lib/setup-steps";
  import type { SetupStreamStep } from "../../../shared/types";

  interface Props {
    active?: boolean;
  }
  let { active = true }: Props = $props();

  const connections = connectionsStore;
  const setup = serverSetupStore;
  const capabilities = $derived(connections.capabilities);
  const gaps = $derived(setupStepIdsForCapabilities(capabilities));
  const visible = $derived(active && hasSetupGaps(capabilities));

  let selectedRepoFullName = $state("");

  const selectedRepo = $derived(
    setup.repos.find((repo) => repo.fullName === selectedRepoFullName) ??
      setup.repos[0] ??
      null,
  );

  onMount(() => {
    const unlisten = setup.listen();
    void connections.refreshCapabilities();
    return unlisten;
  });

  $effect(() => {
    setup.syncServerName(capabilities?.serverName);
  });

  $effect(() => {
    if (!visible || !capabilities?.gitAuth.github || capabilities.projectCount !== 0) return;
    void setup.loadGithubRepos();
  });

  $effect(() => {
    if (!visible || !connections.providerStatus?.connected) return;
    void connections.refreshCapabilities();
    void setup.loadGithubRepos({ force: true });
  });

  $effect(() => {
    if (selectedRepoFullName && setup.repos.some((repo) => repo.fullName === selectedRepoFullName)) return;
    selectedRepoFullName = setup.repos[0]?.fullName ?? "";
  });

  async function saveName() {
    await setup.saveServerName();
    requestInputFocus();
  }

  async function installClaude() {
    await setup.installClaude();
    requestInputFocus();
  }

  async function checkClaudeAuth() {
    await setup.checkClaudeAuth();
    requestInputFocus();
  }

  async function reloadRepos() {
    await setup.loadGithubRepos({ force: true });
    requestInputFocus();
  }

  async function cloneSelectedRepo() {
    if (!selectedRepo) return;
    await setup.cloneRepo(selectedRepo);
    requestInputFocus();
  }

  function stepStatus(step: SetupChecklistStepId): "pending" | "running" | "done" | "failed" {
    if (!capabilities) return "pending";
    if (step === "install-claude") {
      if (capabilities.agents.claude) return "done";
      const status = setup.statuses["install-claude"];
      return status === "running" || status === "failed" ? status : "pending";
    }
    if (step === "claude-auth") return capabilities.agentAuth.claude ? "done" : "pending";
    if (step === "github") return capabilities.gitAuth.github ? "done" : "pending";
    if (step === "project") {
      if (capabilities.projectCount > 0) return "done";
      const status = setup.statuses.clone;
      return status === "running" || status === "failed" ? status : "pending";
    }
    return "pending";
  }

  function streamStep(step: SetupChecklistStepId): SetupStreamStep | null {
    if (step === "install-claude") return "install-claude";
    if (step === "project") return "clone";
    return null;
  }
</script>

{#snippet statusIcon(status: "pending" | "running" | "done" | "failed")}
  {#if status === "done"}
    <CheckCircleIcon size={17} weight="fill" class="text-(--solus-status-complete)" />
  {:else if status === "running"}
    <SpinnerGapIcon size={17} class="animate-spin text-(--solus-accent)" />
  {:else if status === "failed"}
    <WarningCircleIcon size={17} weight="fill" class="text-(--solus-status-error)" />
  {:else}
    <CircleIcon size={17} class="text-(--solus-text-tertiary)" />
  {/if}
{/snippet}

{#snippet setupLogs(step: SetupStreamStep)}
  {@const lines = setup.logs[step]}
  {@const status = setup.statuses[step]}
  {@const error = setup.errors[step]}
  {#if lines.length > 0 || error}
    <details
      class="group/log mt-3 rounded-lg bg-(--solus-surface-secondary) shadow-[0_0_0_1px_color-mix(in_srgb,var(--solus-container-border)_72%,transparent)]"
      open={status === "running" || status === "failed"}
    >
      <summary
        class="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 text-[0.75rem] font-medium text-(--solus-text-secondary) outline-none focus-visible:ring-2 focus-visible:ring-(--solus-accent) [&::-webkit-details-marker]:hidden"
      >
        <CaretDownIcon
          size={13}
          class="transition-transform duration-150 group-open/log:rotate-180"
        />
        Installer output
        <span class="ml-auto tabular-nums text-(--solus-text-tertiary)">{lines.length}</span>
      </summary>
      <div
        class="max-h-40 overflow-auto border-t border-(--solus-tool-border) px-3 py-2 font-mono text-[0.6875rem] leading-relaxed text-(--solus-text-secondary)"
        role="log"
      >
        {#each lines as line, i}
          <div class="whitespace-pre-wrap break-words" data-line={i}>{line}</div>
        {/each}
        {#if error}
          <div class="mt-1 whitespace-pre-wrap break-words text-(--solus-status-error)">{error}</div>
        {/if}
      </div>
    </details>
  {/if}
{/snippet}

{#snippet stepShell(step: SetupChecklistStepId, title: string, body: string)}
  {@const status = stepStatus(step)}
  {@const logStep = streamStep(step)}
  <section
    class="border-t border-(--solus-tool-border) px-4 py-3.5 first:border-t-0 sm:px-5"
    aria-label={title}
  >
    <div class="flex items-start gap-3">
      <div class="mt-0.5 flex size-5 shrink-0 items-center justify-center">
        {@render statusIcon(status)}
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 class="text-balance text-[0.875rem] font-semibold text-(--solus-text-primary)">
            {title}
          </h3>
          {#if status === "running"}
            <span class="rounded-full bg-(--solus-accent-light) px-2 py-0.5 text-[0.625rem] font-medium text-(--solus-accent)">
              Running
            </span>
          {:else if status === "failed"}
            <span class="rounded-full bg-red-500/10 px-2 py-0.5 text-[0.625rem] font-medium text-(--solus-status-error)">
              Failed
            </span>
          {/if}
        </div>
        <p class="mt-1 text-pretty text-[0.75rem] leading-snug text-(--solus-text-tertiary)">
          {body}
        </p>
        <div class="mt-3">
          {@render stepBody(step, status)}
        </div>
        {#if logStep}
          {@render setupLogs(logStep)}
        {/if}
      </div>
    </div>
  </section>
{/snippet}

{#snippet stepBody(step: SetupChecklistStepId, status: "pending" | "running" | "done" | "failed")}
  {#if step === "install-claude"}
    <button
      type="button"
      onclick={installClaude}
      disabled={status === "running"}
      class="inline-flex min-h-10 items-center gap-2 rounded-lg bg-(--solus-accent) px-3.5 text-[0.8125rem] font-medium text-(--solus-text-on-accent) transition-[opacity,scale] duration-150 hover:opacity-90 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
    >
      {#if status === "running"}
        <SpinnerGapIcon size={15} class="animate-spin" />
        Installing...
      {:else}
        <DownloadSimpleIcon size={15} />
        Install Claude Code
      {/if}
    </button>
  {:else if step === "claude-auth"}
    <div class="flex flex-col gap-3">
      <div class="rounded-lg bg-(--solus-surface-secondary) px-3 py-2 text-[0.75rem] text-(--solus-text-secondary) shadow-[0_0_0_1px_color-mix(in_srgb,var(--solus-container-border)_72%,transparent)]">
        Run <code class="font-mono text-(--solus-text-primary)">claude setup-token</code> on this server, finish the browser sign-in, then check again.
      </div>
      <button
        type="button"
        onclick={checkClaudeAuth}
        class="inline-flex min-h-10 w-fit items-center gap-2 rounded-lg border border-(--solus-tool-border) bg-transparent px-3 text-[0.8125rem] font-medium text-(--solus-text-secondary) transition-[background-color,border-color,scale] duration-150 hover:border-(--solus-accent-border-medium) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
      >
        <ArrowClockwiseIcon size={15} />
        Check again
      </button>
    </div>
  {:else if step === "github"}
    <GitHubConnect />
  {:else if step === "project"}
    <div class="flex flex-col gap-3">
      {#if !capabilities?.gitAuth.github}
        <div class="rounded-lg bg-(--solus-surface-secondary) px-3 py-2 text-[0.75rem] text-(--solus-text-tertiary) shadow-[0_0_0_1px_color-mix(in_srgb,var(--solus-container-border)_72%,transparent)]">
          Connect GitHub first, then pick a repository to clone.
        </div>
      {:else}
        <div class="flex flex-col gap-2 sm:flex-row">
          <select
            bind:value={selectedRepoFullName}
            disabled={setup.reposLoading || setup.repos.length === 0}
            class="min-h-10 min-w-0 flex-1 rounded-lg border border-(--solus-tool-border) bg-(--solus-surface) px-3 text-[0.8125rem] text-(--solus-text-primary) outline-none focus:border-(--solus-accent-border-medium) focus:ring-2 focus:ring-(--solus-accent-light) disabled:opacity-60"
            aria-label="Repository"
          >
            {#if setup.reposLoading}
              <option>Loading repositories...</option>
            {:else if setup.repos.length === 0}
              <option>No repositories found</option>
            {:else}
              {#each setup.repos as repo (repo.fullName)}
                <option value={repo.fullName}>
                  {repo.fullName}{repo.private ? " (private)" : ""}
                </option>
              {/each}
            {/if}
          </select>
          <button
            type="button"
            onclick={cloneSelectedRepo}
            disabled={!selectedRepo || setup.statuses.clone === "running"}
            class="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-(--solus-accent) px-3.5 text-[0.8125rem] font-medium text-(--solus-text-on-accent) transition-[opacity,scale] duration-150 hover:opacity-90 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
          >
            {#if setup.statuses.clone === "running"}
              <SpinnerGapIcon size={15} class="animate-spin" />
              Cloning...
            {:else}
              <GitBranchIcon size={15} />
              Clone
            {/if}
          </button>
          <button
            type="button"
            onclick={reloadRepos}
            disabled={setup.reposLoading}
            class="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-(--solus-tool-border) bg-transparent px-3 text-[0.8125rem] font-medium text-(--solus-text-secondary) transition-[background-color,border-color,scale] duration-150 hover:border-(--solus-accent-border-medium) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
            aria-label="Refresh repositories"
          >
            <ArrowClockwiseIcon size={15} class={setup.reposLoading ? "animate-spin" : ""} />
          </button>
        </div>
        {#if setup.reposError}
          <p class="text-[0.75rem] text-(--solus-status-error)">{setup.reposError}</p>
        {/if}
        {#if setup.clonedProjectPath}
          <p class="truncate text-[0.75rem] text-(--solus-status-complete)">
            Cloned to {setup.clonedProjectPath}
          </p>
        {/if}
      {/if}
    </div>
  {/if}
{/snippet}

{#if visible}
  <aside
    class="w-full overflow-hidden rounded-2xl bg-(--solus-surface) shadow-[0_0_0_1px_color-mix(in_srgb,var(--solus-container-border)_88%,transparent),0_8px_24px_rgba(0,0,0,0.06)]"
    aria-label="Server setup checklist"
  >
    <div class="flex items-start gap-3 px-4 py-4 sm:px-5">
      <div class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-(--solus-accent-light) text-(--solus-accent)">
        <PencilSimpleIcon size={18} weight="duotone" />
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <h2 class="text-balance text-[0.9375rem] font-semibold text-(--solus-text-primary)">
            Finish server setup
          </h2>
          <span class="rounded-full bg-(--solus-surface-secondary) px-2 py-0.5 text-[0.625rem] font-medium tabular-nums text-(--solus-text-tertiary)">
            {gaps.length} left
          </span>
        </div>
        <p class="mt-1 text-pretty text-[0.75rem] leading-snug text-(--solus-text-tertiary)">
          Name this server, connect the tools it needs, and clone the first project.
        </p>
      </div>
      <button
        type="button"
        class="inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-(--solus-text-tertiary) transition-[background-color,color,scale] duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
        aria-label={setup.collapsed ? "Expand setup checklist" : "Collapse setup checklist"}
        onclick={() => {
          setup.collapsed = !setup.collapsed;
          requestInputFocus();
        }}
      >
        <CaretDownIcon
          size={16}
          class="transition-transform duration-150 {setup.collapsed ? '-rotate-90' : ''}"
        />
      </button>
    </div>

    {#if !setup.collapsed}
      <div class="border-t border-(--solus-tool-border) px-4 py-3.5 sm:px-5">
        <label class="flex flex-col gap-2 sm:flex-row sm:items-center">
          <span class="inline-flex min-w-28 items-center gap-2 text-[0.75rem] font-medium text-(--solus-text-secondary)">
            <PencilSimpleIcon size={14} />
            Server name
          </span>
          <input
            bind:value={setup.serverNameDraft}
            oninput={() => setup.markServerNameDirty()}
            class="min-h-10 min-w-0 flex-1 rounded-lg border border-(--solus-tool-border) bg-(--solus-surface) px-3 text-[0.8125rem] text-(--solus-text-primary) outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-(--solus-text-muted) focus:border-(--solus-accent-border-medium) focus:ring-2 focus:ring-(--solus-accent-light)"
            placeholder="Solus Server"
          />
          <button
            type="button"
            onclick={saveName}
            disabled={setup.savingName}
            class="inline-flex min-h-10 items-center justify-center rounded-lg bg-(--solus-accent) px-3.5 text-[0.8125rem] font-medium text-(--solus-text-on-accent) transition-[opacity,scale] duration-150 hover:opacity-90 active:scale-[0.96] disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
          >
            {setup.savingName ? "Saving..." : "Save"}
          </button>
        </label>
        {#if setup.nameError}
          <p class="mt-2 text-[0.75rem] text-(--solus-status-error)">{setup.nameError}</p>
        {/if}
      </div>

      {#each gaps as gap (gap)}
        {#if gap === "install-claude"}
          {@render stepShell("install-claude", "Install Claude Code", "Install the agent CLI on the server so sessions can run from any paired client.")}
        {:else if gap === "claude-auth"}
          {@render stepShell("claude-auth", "Sign in to Claude", "Claude sign-in is interactive in v1, so the checklist gives the command and re-checks credentials.")}
        {:else if gap === "github"}
          {@render stepShell("github", "Connect GitHub", "Authorize GitHub once so the server can list repositories and clone your first project.")}
        {:else if gap === "project"}
          {@render stepShell("project", "Clone first project", "Pick a recent GitHub repository and the server will clone it into its workspace projects folder.")}
        {/if}
      {/each}
    {/if}
  </aside>
{/if}
