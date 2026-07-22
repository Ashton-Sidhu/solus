<script lang="ts">
  import { onMount } from "svelte";
  import {
    ArrowClockwiseIcon,
    CaretDownIcon,
    CheckIcon,
    CircleIcon,
    DownloadSimpleIcon,
    GithubLogoIcon,
    GitBranchIcon,
    PencilSimpleIcon,
    SpinnerGapIcon,
    WarningCircleIcon,
  } from "phosphor-svelte";
  import { connectionsStore } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import GitHubConnect from "../connections/GitHubConnect.svelte";
  import { serverSetupStore } from "./server-setup.store.svelte";
  import {
    completedSetupStepIds,
    hasSetupGaps,
    SETUP_JOURNEY_STEPS,
    setupStepIdsForCapabilities,
    type SetupChecklistStepId,
    type SetupJourneyStepId,
  } from "./lib/setup-steps";
  import type { SetupStreamStep } from "../../../shared/types";
  import { Input } from "../ui/input";

  interface Props {
    active?: boolean;
  }
  let { active = true }: Props = $props();

  const connections = connectionsStore;
  const setup = serverSetupStore;
  const capabilities = $derived(connections.capabilities);
  const gaps = $derived(setupStepIdsForCapabilities(capabilities));
  const completedSteps = $derived(completedSetupStepIds(capabilities));
  const completedCount = $derived(completedSteps.length);
  const currentStepId = $derived(gaps[0] ?? null);
  const currentStep = $derived(
    SETUP_JOURNEY_STEPS.find((step) => step.id === currentStepId) ?? null,
  );
  const currentStepNumber = $derived(
    currentStepId
      ? SETUP_JOURNEY_STEPS.findIndex((step) => step.id === currentStepId) + 1
      : SETUP_JOURNEY_STEPS.length,
  );
  const visible = $derived(active && hasSetupGaps(capabilities));

  let selectedRepoFullName = $state("");
  let editingName = $state(false);
  let nameInput = $state<HTMLInputElement | null>(null);

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

  function startEditingName() {
    editingName = true;
    Promise.resolve().then(() => nameInput?.focus());
  }

  async function saveName() {
    if (await setup.saveServerName()) editingName = false;
    requestInputFocus();
  }

  function handleNameKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      void saveName();
    } else if (event.key === "Escape") {
      editingName = false;
      requestInputFocus();
    }
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
    if (capabilities.projectCount > 0) return "done";
    const status = setup.statuses.clone;
    return status === "running" || status === "failed" ? status : "pending";
  }

  function journeyStatus(step: SetupJourneyStepId): "pending" | "active" | "running" | "done" | "failed" {
    if (completedSteps.includes(step)) return "done";
    if (step !== currentStepId || step === "server-name") return "pending";
    const status = stepStatus(step);
    return status === "pending" ? "active" : status;
  }

  function streamStep(step: SetupChecklistStepId): SetupStreamStep | null {
    if (step === "install-claude") return "install-claude";
    if (step === "project") return "clone";
    return null;
  }
</script>

{#snippet journeyIcon(step: SetupJourneyStepId, status: "pending" | "active" | "running" | "done" | "failed")}
  {#if status === "done"}
    <CheckIcon size={14} weight="bold" />
  {:else if status === "running"}
    <SpinnerGapIcon size={14} class="animate-spin" />
  {:else if status === "failed"}
    <WarningCircleIcon size={15} weight="fill" />
  {:else if step === "server-name"}
    <PencilSimpleIcon size={14} />
  {:else if step === "install-claude"}
    <DownloadSimpleIcon size={14} />
  {:else if step === "claude-auth"}
    <CircleIcon size={14} />
  {:else if step === "github"}
    <GithubLogoIcon size={14} weight="fill" />
  {:else}
    <GitBranchIcon size={14} />
  {/if}
{/snippet}

{#snippet setupLogs(step: SetupStreamStep)}
  {@const lines = setup.logs[step]}
  {@const status = setup.statuses[step]}
  {#if lines.length > 0}
    <details
      class="group/log mt-3 overflow-hidden rounded-lg bg-(--solus-container-bg) shadow-[0_0_0_1px_color-mix(in_srgb,var(--solus-container-border)_72%,transparent)]"
      open={status === "running" || status === "failed"}
    >
      <summary
        class="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 text-[0.75rem] font-medium text-(--solus-text-secondary) outline-none focus-visible:ring-2 focus-visible:ring-(--solus-accent) [&::-webkit-details-marker]:hidden"
      >
        <CaretDownIcon size={13} class="transition-transform duration-150 group-open/log:rotate-180" />
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
      </div>
    </details>
  {/if}
{/snippet}

{#snippet stepBody(step: SetupChecklistStepId, status: "pending" | "running" | "done" | "failed")}
  {#if step === "install-claude"}
    <button
      type="button"
      onclick={installClaude}
      disabled={status === "running"}
      class="inline-flex min-h-10 items-center gap-2 rounded-lg bg-(--solus-accent) pl-3.5 pr-3 text-[0.8125rem] font-medium text-(--solus-text-on-accent) transition-[opacity,scale] duration-150 hover:opacity-90 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
    >
      {#if status === "running"}
        <SpinnerGapIcon size={15} class="animate-spin" />
        Installing…
      {:else}
        <DownloadSimpleIcon size={15} />
        Install Claude Code
      {/if}
    </button>
  {:else if step === "claude-auth"}
    <div class="flex flex-col gap-3">
      <div class="rounded-lg bg-(--solus-container-bg) px-3 py-2.5 text-[0.75rem] text-(--solus-text-secondary) shadow-[0_0_0_1px_color-mix(in_srgb,var(--solus-container-border)_72%,transparent)]">
        Run <code class="font-mono text-(--solus-text-primary)">claude setup-token</code> on this server, finish the browser sign-in, then check again.
      </div>
      <button
        type="button"
        onclick={checkClaudeAuth}
        class="inline-flex min-h-10 w-fit items-center gap-2 rounded-lg bg-(--solus-container-bg) pl-3 pr-2.5 text-[0.8125rem] font-medium text-(--solus-text-secondary) shadow-[0_0_0_1px_color-mix(in_srgb,var(--solus-container-border)_72%,transparent)] transition-[background-color,box-shadow,color,scale] duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
      >
        <ArrowClockwiseIcon size={15} />
        Check again
      </button>
    </div>
  {:else if step === "github"}
    <GitHubConnect />
  {:else}
    <div class="flex flex-col gap-3">
      {#if !capabilities?.gitAuth.github}
        <div class="rounded-lg bg-(--solus-container-bg) px-3 py-2.5 text-[0.75rem] text-(--solus-text-tertiary) shadow-[0_0_0_1px_color-mix(in_srgb,var(--solus-container-border)_72%,transparent)]">
          Connect GitHub first, then pick a repository to clone.
        </div>
      {:else}
        <div class="flex flex-col gap-2 sm:flex-row">
          <select
            bind:value={selectedRepoFullName}
            disabled={setup.reposLoading || setup.repos.length === 0}
            class="min-h-10 min-w-0 flex-1 rounded-lg border border-(--solus-input-border) bg-(--solus-container-bg) px-3 text-[0.8125rem] text-(--solus-text-primary) outline-none transition-[border-color,box-shadow] duration-150 focus:border-(--solus-input-focus-border) focus:ring-2 focus:ring-(--solus-input-focus-ring) disabled:opacity-60"
            aria-label="Repository"
          >
            {#if setup.reposLoading}
              <option>Loading repositories…</option>
            {:else if setup.repos.length === 0}
              <option>No repositories found</option>
            {:else}
              {#each setup.repos as repo (repo.fullName)}
                <option value={repo.fullName}>{repo.fullName}{repo.private ? " (private)" : ""}</option>
              {/each}
            {/if}
          </select>
          <button
            type="button"
            onclick={cloneSelectedRepo}
            disabled={!selectedRepo || setup.statuses.clone === "running"}
            class="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-(--solus-accent) pl-3.5 pr-3 text-[0.8125rem] font-medium text-(--solus-text-on-accent) transition-[opacity,scale] duration-150 hover:opacity-90 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
          >
            {#if setup.statuses.clone === "running"}
              <SpinnerGapIcon size={15} class="animate-spin" />
              Cloning…
            {:else}
              <GitBranchIcon size={15} />
              Clone
            {/if}
          </button>
          <button
            type="button"
            onclick={reloadRepos}
            disabled={setup.reposLoading}
            class="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-(--solus-container-bg) text-(--solus-text-secondary) shadow-[0_0_0_1px_color-mix(in_srgb,var(--solus-container-border)_72%,transparent)] transition-[background-color,color,scale] duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
            aria-label="Refresh repositories"
          >
            <ArrowClockwiseIcon size={15} class={setup.reposLoading ? "animate-spin" : ""} />
          </button>
        </div>
        {#if setup.clonedProjectPath}
          <p class="truncate text-[0.75rem] text-(--solus-status-complete)">Cloned to {setup.clonedProjectPath}</p>
        {/if}
      {/if}
    </div>
  {/if}
{/snippet}

{#if visible && currentStep && currentStepId}
  {@const currentStatus = stepStatus(currentStepId)}
  {@const logStep = streamStep(currentStepId)}
  <aside
    class="w-full overflow-hidden rounded-[0.875rem] border border-(--solus-tool-border) bg-transparent sm:rounded-xl"
    aria-label="Server setup checklist"
  >
    <header class="flex items-center gap-2.5 px-3.5 py-2.5">
      <div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-(--solus-accent-light) text-(--solus-accent)">
        <GitBranchIcon size={15} weight="duotone" />
      </div>
      <div class="min-w-0 flex-1">
        <h2 class="truncate text-[0.8125rem] font-medium text-(--solus-text-primary)">Set up your server</h2>
        <p class="mt-0.5 text-[0.625rem] tabular-nums text-(--solus-text-tertiary)">
          {completedCount} of {SETUP_JOURNEY_STEPS.length} complete
        </p>
      </div>
      <button
        type="button"
        onclick={startEditingName}
        class="hidden min-h-10 max-w-40 items-center gap-1.5 rounded-lg bg-transparent px-2.5 text-[0.6875rem] text-(--solus-text-tertiary) transition-[background-color,color,scale] duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent) sm:inline-flex"
        aria-label="Edit server name"
      >
        <span class="truncate">{capabilities?.serverName || setup.serverNameDraft}</span>
        <PencilSimpleIcon size={12} class="shrink-0" />
      </button>
      <button
        type="button"
        class="inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-(--solus-text-tertiary) transition-[background-color,color,scale] duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
        aria-label={setup.collapsed ? "Expand setup checklist" : "Collapse setup checklist"}
        onclick={() => {
          setup.collapsed = !setup.collapsed;
          requestInputFocus();
        }}
      >
        <CaretDownIcon size={16} class="transition-transform duration-150 {setup.collapsed ? '-rotate-90' : ''}" />
      </button>
    </header>

    {#if !setup.collapsed}
      <div class="border-t border-(--solus-tool-border) px-3.5 pb-3.5 pt-3">
        {#if !editingName}
          <button
            type="button"
            onclick={startEditingName}
            class="mb-3 inline-flex min-h-10 max-w-full items-center gap-1.5 rounded-lg bg-transparent px-2.5 text-[0.6875rem] text-(--solus-text-tertiary) shadow-[0_0_0_1px_var(--solus-tool-border)] transition-[background-color,color,scale] duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent) sm:hidden"
            aria-label="Edit server name"
          >
            <span class="truncate">{capabilities?.serverName || setup.serverNameDraft}</span>
            <PencilSimpleIcon size={12} class="shrink-0" />
          </button>
        {/if}
        {#if editingName}
          <div class="mb-3 flex flex-col gap-2 rounded-lg p-2 shadow-[0_0_0_1px_var(--solus-tool-border)] sm:flex-row sm:items-center">
            <label for="setup-server-name" class="shrink-0 text-[0.75rem] font-medium text-(--solus-text-secondary)">Server name</label>
            <Input
              id="setup-server-name"
              bind:ref={nameInput}
              bind:value={setup.serverNameDraft}
              oninput={() => setup.markServerNameDirty()}
              onkeydown={handleNameKeydown}
              class="min-h-10 min-w-0 flex-1 rounded-lg border border-(--solus-input-border) bg-(--solus-container-bg) px-3 text-[0.8125rem] text-(--solus-text-primary) outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-(--solus-text-muted) focus:border-(--solus-input-focus-border) focus:ring-2 focus:ring-(--solus-input-focus-ring)"
              placeholder="Solus Server"
            />
            <button
              type="button"
              onclick={saveName}
              disabled={setup.savingName}
              class="inline-flex min-h-10 items-center justify-center rounded-lg bg-(--solus-accent) px-3.5 text-[0.8125rem] font-medium text-(--solus-text-on-accent) transition-[opacity,scale] duration-150 hover:opacity-90 active:scale-[0.96] disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
            >
              {setup.savingName ? "Saving…" : "Save"}
            </button>
          </div>
        {/if}

        <div class="mb-3 flex gap-1.5" aria-label="Setup progress">
          {#each SETUP_JOURNEY_STEPS as step, index (step.id)}
            {@const status = journeyStatus(step.id)}
            <div
              class="h-1 min-w-0 flex-1 rounded-full transition-[background-color] duration-200 {status === 'done'
                ? 'bg-(--solus-status-complete)'
                : status === 'active' || status === 'running'
                  ? 'bg-(--solus-accent)'
                  : status === 'failed'
                    ? 'bg-(--solus-status-error)'
                    : 'bg-(--solus-surface-active)'}"
              aria-current={step.id === currentStepId ? "step" : undefined}
            >
              <span class="sr-only">Step {index + 1}: {step.label}, {status}</span>
            </div>
          {/each}
        </div>

        <section class="border-t border-(--solus-tool-border) pt-3" aria-label={currentStep.title}>
          <div class="flex items-start gap-2.5">
            <div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-(--solus-accent-light) text-(--solus-accent)">
              {@render journeyIcon(currentStepId, journeyStatus(currentStepId))}
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <h3 class="text-balance text-[0.8125rem] font-medium text-(--solus-text-primary)">{currentStep.title}</h3>
                <span class="text-[0.625rem] tabular-nums text-(--solus-text-tertiary)">Step {currentStepNumber} of {SETUP_JOURNEY_STEPS.length}</span>
              </div>
              <p class="mt-0.5 text-pretty text-[0.6875rem] leading-relaxed text-(--solus-text-tertiary)">{currentStep.description}</p>
            </div>
          </div>
          <div class="mt-3">
            {@render stepBody(currentStepId, currentStatus)}
          </div>
          {#if logStep}
            {@render setupLogs(logStep)}
          {/if}
        </section>
      </div>
    {/if}
  </aside>
{/if}
