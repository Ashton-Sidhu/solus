<script lang="ts">
  import { tick, onDestroy } from "svelte";
  import {
    PlayCircleIcon,
    PlusIcon,
    TrashIcon,
    ListChecksIcon,
    MegaphoneIcon,
    PlugIcon,
    WarningCircleIcon,
  } from "phosphor-svelte";
  import { getProjectConfigStore } from "../../contexts/project-config.store.svelte";
  import { getRunStore } from "../../contexts/run.store.svelte";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import type { TaskProviderId, TaskProviderStatus } from "../../../shared/task-types";

  interface Props {
    cwd: string;
  }
  let { cwd }: Props = $props();

  const projectConfig = getProjectConfigStore();
  const runStore = getRunStore();
  const session = getWorkspaceContext();

  // Task provider — `local` (default) is the built-in store; `github` reads
  // issues from an explicit owner/repo when set, otherwise the `origin` remote.
  let taskProvider = $state<TaskProviderId>("local");
  let repoOwner = $state("");
  let repoName = $state("");
  let providerStatus = $state<TaskProviderStatus | null>(null);
  let providerStatusLoading = $state(false);
  async function onProviderChange(next: TaskProviderId) {
    taskProvider = next;
    status = "saving";
    await projectConfig.save(cwd, { taskProvider: next });
    await reloadTasksIfActive();
    await refreshProviderStatus();
    status = "saved";
  }

  async function refreshProviderStatus() {
    providerStatusLoading = true;
    try {
      providerStatus = await window.solus.tasksProviderStatus(cwd, { checkAccess: true });
      if (!repoOwner && !repoName && providerStatus.repo?.source === "origin") {
        repoOwner = providerStatus.repo.owner;
        repoName = providerStatus.repo.repo;
      }
    } finally {
      providerStatusLoading = false;
    }
  }

  async function saveRepo() {
    const owner = repoOwner.trim();
    const repo = repoName.trim();
    status = "saving";
    await projectConfig.save(cwd, {
      taskProviderConfig: owner && repo ? { owner, repo } : undefined,
    });
    await reloadTasksIfActive();
    await refreshProviderStatus();
    status = "saved";
  }

  async function reloadTasksIfActive() {
    if (session.tasksProjectCwd === cwd) await session.tasksStore.load(cwd);
  }

  // Session-start write-back — on by default; the opt-out keeps an exploratory
  // session from announcing itself on the shared tracker.
  let taskWriteBack = $state(true);
  async function onWriteBackChange(enabled: boolean) {
    taskWriteBack = enabled;
    status = "saving";
    await projectConfig.save(cwd, { taskStartWriteBack: enabled });
    status = "saved";
  }

  interface Row {
    id: string;
    name: string;
    command: string;
    port: string;
  }

  let rows = $state<Row[]>([]);
  let status = $state<"idle" | "saving" | "saved">("idle");
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let commandInputs = $state<HTMLInputElement[]>([]);
  const anyRunning = $derived(
    (runStore.runsFor(cwd) ?? []).some(
      (r) => r.state === "running" || r.state === "starting",
    ),
  );

  $effect(() => {
    if (!cwd) return;
    void projectConfig.load(cwd).then((loaded) => {
      taskProvider = loaded?.taskProvider ?? "local";
      repoOwner = loaded?.taskProviderConfig?.owner ?? "";
      repoName = loaded?.taskProviderConfig?.repo ?? "";
      taskWriteBack = loaded?.taskStartWriteBack !== false;
      rows = (loaded?.runCommands ?? []).map((entry) => ({
        id: entry.id,
        name: entry.name ?? "",
        command: entry.command,
        port: entry.port ? String(entry.port) : "",
      }));
      if (rows.length === 0) addRow();
      void tick().then(() => commandInputs[0]?.focus());
      void refreshProviderStatus();
    });
  });

  function addRow() {
    rows.push({ id: crypto.randomUUID(), name: "", command: "", port: "" });
  }

  function removeRow(index: number) {
    rows.splice(index, 1);
    // Structural change — persist immediately rather than waiting on the debounce.
    void save();
  }

  // Debounce text edits so we don't write the config on every keystroke.
  function scheduleSave() {
    status = "saving";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(), 600);
  }

  async function save() {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    status = "saving";
    const runCommands = rows
      .filter((row) => row.command.trim())
      .map((row) => {
        const port = row.port.trim() ? Number(row.port) : undefined;
        return {
          id: row.id,
          name: row.name.trim() || undefined,
          command: row.command.trim(),
          port: port && Number.isFinite(port) ? port : undefined,
        };
      });
    await projectConfig.save(cwd, { runCommands });
    await runStore.refreshProjectConfig(cwd);
    status = "saved";
  }

  // Flush a pending debounced save when switching projects or closing settings.
  onDestroy(() => {
    if (saveTimer) void save();
  });

  const inputClass = "min-h-8 border border-(--solus-container-border) rounded-lg bg-(--solus-input-bg-soft) text-(--solus-text-primary) px-2.5 text-[0.75rem] outline-none placeholder:text-(--solus-text-tertiary) placeholder:opacity-70 focus:border-(--solus-accent) focus:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_30%,transparent)]";
</script>

<div class="flex flex-col">
  <section class="flex flex-col border-(--solus-container-border)/50 pb-2">
    <h2 class="text-(--solus-text-tertiary) text-[0.65625rem] font-semibold tracking-[0.05em] uppercase">Tasks</h2>
    <div class="flex items-center justify-between gap-4 py-3.5 pb-2.5">
      <div class="flex items-center gap-3 min-w-0">
        <ListChecksIcon size={16} class="shrink-0 text-(--solus-text-tertiary)" />
        <div>
          <div class="text-[0.8125rem] font-medium text-(--solus-text-primary)">Task provider</div>
          <div class="text-[0.6875rem] text-(--solus-text-tertiary) mt-px">
            Where this project's tasks come from. GitHub reads issues from the
            configured repo, falling back to <code>origin</code> when unset.
          </div>
        </div>
      </div>
      <select
        class="{inputClass} w-36 shrink-0 cursor-pointer"
        aria-label="Task provider"
        value={taskProvider}
        onchange={(e) =>
          onProviderChange(e.currentTarget.value as TaskProviderId)}
      >
        <option value="local">Local</option>
        <option value="github">GitHub</option>
      </select>
    </div>
    {#if taskProvider === "github"}
      <div class="ml-7 mb-2 flex flex-col gap-2 rounded-lg border border-(--solus-container-border)/70 bg-(--solus-surface-hover)/45 p-3">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex items-center gap-1.5 text-[0.75rem] font-medium {providerStatus?.ok ? 'text-(--solus-text-primary)' : 'text-(--solus-status-error)'}">
              {#if providerStatus?.ok}
                <ListChecksIcon size={13} />
              {:else}
                <WarningCircleIcon size={13} />
              {/if}
              <span>{providerStatusLoading ? "Checking GitHub…" : (providerStatus?.message ?? "Checking GitHub…")}</span>
            </div>
            {#if providerStatus?.repo}
              <div class="mt-1 text-[0.6875rem] text-(--solus-text-tertiary)">
                Repo: <code>{providerStatus.repo.owner}/{providerStatus.repo.repo}</code>
                via {providerStatus.repo.source === "config" ? "project settings" : "origin remote"}
              </div>
            {/if}
            {#if providerStatus?.auth?.connected}
              <div class="mt-1 text-[0.6875rem] text-(--solus-text-tertiary)">
                Connected{providerStatus.auth.login ? ` as @${providerStatus.auth.login}` : ""}
              </div>
            {/if}
            {#if providerStatus?.liveCheck}
              <div class="mt-1 text-[0.6875rem] text-(--solus-text-tertiary)">
                Read {providerStatus.liveCheck.issueCount}{providerStatus.liveCheck.truncated ? "+" : ""}
                issues{providerStatus.liveCheck.planningFieldsDetected ? " · Projects fields detected" : ""}
              </div>
            {/if}
            {#if providerStatus?.warning}
              <div class="mt-1 text-[0.6875rem] text-[#9a6700] [.dark_&]:text-[#d29922]">
                {providerStatus.warning}
              </div>
            {/if}
          </div>
          {#if providerStatus?.reason === "github_not_connected" || providerStatus?.warning}
            <button
              type="button"
              class="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-(--solus-container-border) bg-(--solus-container-bg) px-2.5 py-1.5 text-[0.75rem] font-medium text-(--solus-text-secondary) hover:bg-(--solus-surface-active) hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)]"
              onclick={() => session.showSettings("git-providers")}
            >
              <PlugIcon size={13} />
              {providerStatus?.warning ? "Reconnect" : "Connect"}
            </button>
          {/if}
        </div>
        <div class="flex items-center gap-2">
          <input
            bind:value={repoOwner}
            class="{inputClass} min-w-0 flex-1"
            placeholder={providerStatus?.detectedRepo?.owner ?? "owner"}
            aria-label="GitHub owner"
          />
          <span class="text-[0.75rem] text-(--solus-text-tertiary)">/</span>
          <input
            bind:value={repoName}
            class="{inputClass} min-w-0 flex-1"
            placeholder={providerStatus?.detectedRepo?.repo ?? "repo"}
            aria-label="GitHub repository"
          />
          <button
            type="button"
            class="inline-flex min-h-8 shrink-0 cursor-pointer items-center rounded-lg border border-(--solus-container-border) bg-(--solus-container-bg) px-3 text-[0.75rem] font-medium text-(--solus-text-secondary) hover:bg-(--solus-surface-active) hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)]"
            onclick={saveRepo}
          >
            Save repo
          </button>
        </div>
        <div class="text-[0.6875rem] text-(--solus-text-tertiary)">
          Leave owner/repo empty to use the project's GitHub <code>origin</code> remote.
        </div>
      </div>
    {/if}
    <div class="flex items-center justify-between gap-4 py-3.5 pb-2.5">
      <div class="flex items-center gap-3 min-w-0">
        <MegaphoneIcon size={16} class="shrink-0 text-(--solus-text-tertiary)" />
        <div>
          <div class="text-[0.8125rem] font-medium text-(--solus-text-primary)">Announce session starts</div>
          <div class="text-[0.6875rem] text-(--solus-text-tertiary) mt-px">
            When a session starts from an open task, mark the ticket In Progress
            and post a "started in Solus" comment so teammates see it picked up.
          </div>
        </div>
      </div>
      <input
        type="checkbox"
        class="size-4 shrink-0 cursor-pointer accent-(--solus-accent)"
        aria-label="Announce session starts on the task"
        checked={taskWriteBack}
        onchange={(e) => onWriteBackChange(e.currentTarget.checked)}
      />
    </div>
  </section>

  <section class="mt-5 flex flex-col">
    <h2 class="text-(--solus-text-tertiary) text-[0.65625rem] font-semibold tracking-[0.05em] uppercase">Runs</h2>
    <div class="flex items-center justify-between gap-4 py-3.5 pb-2.5">
      <div class="flex items-center gap-3 min-w-0">
        <PlayCircleIcon size={16} class="shrink-0 text-(--solus-text-tertiary)" />
        <div>
          <div class="text-[0.8125rem] font-medium text-(--solus-text-primary)">Run commands</div>
          <div class="text-[0.6875rem] text-(--solus-text-tertiary) mt-px">
            Commands shown in the Run panel. Each gets its own logs and detected
            ports; set a port to override auto-detection.
          </div>
        </div>
      </div>
    </div>

    <div class="flex flex-col gap-2 pb-3.5">
      {#each rows as row, index (row.id)}
        <div class="flex items-center gap-2">
          <input
            bind:value={row.name}
            oninput={scheduleSave}
            name="run-name-{index}"
            class="{inputClass} w-36 shrink-0"
            placeholder="Name (optional)"
            aria-label="Command name"
          />
          <input
            bind:this={commandInputs[index]}
            bind:value={row.command}
            oninput={scheduleSave}
            name="run-command-{index}"
            class="{inputClass} flex-1 min-w-0 font-(--solus-code-font-family)"
            placeholder="npm run dev"
            aria-label="Run command"
          />
          <input
            bind:value={row.port}
            oninput={scheduleSave}
            name="run-port-{index}"
            inputmode="numeric"
            class="{inputClass} w-[4.5rem] shrink-0"
            placeholder="Port"
            aria-label="Port override"
          />
          <button
            type="button"
            class="w-7 h-7 inline-flex items-center justify-center shrink-0 border-none rounded-md bg-transparent text-(--solus-text-tertiary) cursor-pointer hover:bg-(--solus-status-error-bg) hover:text-(--solus-status-error) focus-visible:outline-none focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)]"
            aria-label="Remove command"
            onclick={() => removeRow(index)}
          >
            <TrashIcon size={13} />
          </button>
        </div>
      {/each}
      <button type="button" class="self-start inline-flex items-center gap-1.5 min-h-7 px-2.5 border border-dashed border-(--solus-container-border) rounded-lg bg-transparent text-(--solus-text-tertiary) text-[0.71875rem] cursor-pointer hover:text-(--solus-text-primary) hover:border-(--solus-accent) focus-visible:outline-none focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)]" onclick={addRow}>
        <PlusIcon size={12} /> Add command
      </button>
    </div>
  </section>

  <div class="mt-4 flex items-center gap-3 min-h-5">
    {#if status === "saving"}
      <span class="text-[0.75rem] text-(--solus-text-tertiary)">Saving…</span>
    {:else if status === "saved"}
      <span class="text-[0.75rem] text-(--solus-text-tertiary)">All changes saved</span>
    {/if}
    {#if anyRunning}
      <span class="text-[0.75rem] text-(--solus-text-tertiary)">
        Restart running commands to apply changes.
      </span>
    {/if}
  </div>
</div>
