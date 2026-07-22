<script lang="ts">
  import {
    ArrowClockwiseIcon,
    ArrowSquareOutIcon,
    CheckIcon,
    ListBulletsIcon,
    PlayIcon,
    RobotIcon,
    SpinnerGapIcon,
    StopIcon,
  } from "phosphor-svelte";
  import {
    getRunStore,
    getRunDockStore,
    getWorkspaceContext,
    getSettingsContext,
  } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { tooltip } from "../../lib/tooltip";
  import { fence, runLabel } from "../../lib/run-utils";
  import type { RunStatus } from "../../../shared/types";
  import { Button } from "../ui/button";

  interface Props {
    cwd: string;
    onConfigure: () => void;
  }
  let { cwd, onConfigure }: Props = $props();

  const runStore = getRunStore();
  const runDock = getRunDockStore();
  const session = getWorkspaceContext();
  const settings = getSettingsContext();
  const runs = $derived(runStore.runsFor(cwd) ?? []);
  const activeSession = $derived(session.sessionFor(session.activeTabId));

  // A 1s tick that only runs while something is live, so uptime stays truthful
  // without invalidating the section when everything is idle.
  let now = $state(Date.now());
  $effect(() => {
    if (!runs.some((r) => isActive(r) && r.startedAt != null)) return;
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });

  $effect(() => {
    if (cwd) void runStore.status(cwd);
  });

  function isActive(run: RunStatus): boolean {
    return run.state === "running" || run.state === "starting";
  }

  async function toggleRun(run: RunStatus) {
    if (isActive(run)) await runStore.stop(cwd, run.commandId);
    else await runStore.start(cwd, run.commandId);
    requestInputFocus();
  }

  async function restartRun(run: RunStatus) {
    await runStore.restart(cwd, run.commandId);
    requestInputFocus();
  }

  // The body and the logs glyph both open this run's logs in the bottom dock.
  function openLogs(run: RunStatus) {
    runDock.openFor(run.commandId);
    settings.update({ runDockOpen: true });
  }

  function openPort(port: number) {
    window.solus.openExternal(`http://localhost:${port}`);
    requestInputFocus();
  }

  // One quiet trailing status word — the single-line panel language. When a
  // running service exposes ports, those take this slot instead (as openable
  // pills); the full command is available on the name's tooltip.
  function trailingText(run: RunStatus): string {
    if (run.state === "starting") return "starting…";
    if (run.state === "running")
      return run.startedAt != null ? uptime(run.startedAt) : "running";
    if (run.state === "completed") return "Completed";
    if (run.state === "error") return "Failed";
    return "";
  }

  function uptime(startedAt: number): string {
    const s = Math.max(0, Math.floor((now - startedAt) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }

  async function debugInNewSession(run: RunStatus) {
    const lines = runStore.logsFor(cwd, run.commandId) ?? [];
    const recent = lines.slice(-40);
    const prompt = [
      `My run command \`${runLabel(run)}\` failed.`,
      run.error ? `Error: ${run.error}` : null,
      recent.length > 0 ? "Recent output:" : null,
      recent.length > 0 ? fence(recent) : null,
      "Investigate why it failed and fix it.",
    ]
      .filter(Boolean)
      .join("\n");
    await session.startNewSessionWithPrompt(
      prompt,
      activeSession?.workingDirectory ?? cwd,
      activeSession?.gitContext ?? null,
    );
    requestInputFocus();
  }
</script>

{#snippet tools(run: RunStatus, active: boolean)}
  {#if active || run.state === "error"}
    <span class="inline-flex" use:tooltip={`Restart ${runLabel(run)}`}>
      <Button
        variant="ghost"
        size="icon-xs"
        class="text-[color-mix(in_srgb,var(--project-icon-blue)_70%,var(--solus-text-tertiary))] hover:bg-[color-mix(in_srgb,var(--project-icon-blue)_12%,transparent)] hover:text-(--project-icon-blue)"
        type="button"
        aria-label="Restart {runLabel(run)}"
        onclick={() => restartRun(run)}
      >
        <ArrowClockwiseIcon size={12} />
      </Button>
    </span>
  {/if}
  {#if run.state === "error"}
    <span
      class="inline-flex"
      use:tooltip={`Debug ${runLabel(run)} with an agent`}
    >
      <Button
        variant="ghost"
        size="icon-xs"
        class="text-(--project-icon-blue) hover:bg-[color-mix(in_srgb,var(--project-icon-blue)_12%,transparent)] hover:text-(--project-icon-blue)"
        type="button"
        aria-label="Debug {runLabel(run)} with an agent"
        onclick={() => debugInNewSession(run)}
      >
        <RobotIcon size={13} />
      </Button>
    </span>
  {/if}
  <span class="inline-flex" use:tooltip={`Show logs for ${runLabel(run)}`}>
    <Button
      variant="ghost"
      size="icon-xs"
      class="text-[color-mix(in_srgb,var(--project-icon-blue)_70%,var(--solus-text-tertiary))] hover:bg-[color-mix(in_srgb,var(--project-icon-blue)_12%,transparent)] hover:text-(--project-icon-blue)"
      type="button"
      aria-label="Show logs for {runLabel(run)}"
      onclick={() => openLogs(run)}
    >
      <ListBulletsIcon size={13} />
    </Button>
  </span>
{/snippet}

{#if runs.length === 0}
  <button
    class="empty-cta flex w-full cursor-pointer items-center gap-2 rounded-[0.4375rem] border-0 bg-transparent px-1 py-1.5 text-left"
    type="button"
    onclick={onConfigure}
  >
    <span
      class="empty-glyph inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
      ><PlayIcon size={12} weight="fill" /></span
    >
    <span class="empty-copy flex min-w-0 flex-col gap-px">
      <span class="empty-title text-[0.8125rem] font-medium"
        >No run command yet</span
      >
      <span class="empty-sub text-[0.6875rem]">Configure a command…</span>
    </span>
  </button>
{:else}
  <div class="run-list flex flex-col gap-px">
    {#each runs as run (run.commandId)}
      {@const active = isActive(run)}
      {@const ports = active ? run.ports : []}
      <div class="service rounded-[0.4375rem]">
        <div
          class="svc-row flex min-h-8 items-center gap-1.5 rounded-[0.4375rem] py-[0.1875rem] pr-1 pl-[0.1875rem]"
        >
          <!-- Leading glyph IS the start / stop / cancel control. -->
          <button
            class="svc-toggle state-{run.state} relative inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent"
            type="button"
            aria-label={active
              ? `Stop ${runLabel(run)}`
              : `Start ${runLabel(run)}`}
            onclick={() => toggleRun(run)}
            use:tooltip={active
              ? `Stop ${runLabel(run)}`
              : `Start ${runLabel(run)}`}
          >
            {#if run.state === "starting"}
              <span class="glyph-spin inline-flex"
                ><SpinnerGapIcon size={12} /></span
              >
            {:else if run.state === "running"}
              <span class="svc-dot h-[0.4375rem] w-[0.4375rem] rounded-full"
              ></span>
              <span
                class="svc-stop absolute inset-0 inline-flex items-center justify-center opacity-0"
                ><StopIcon size={11} weight="fill" /></span
              >
            {:else if run.state === "completed"}
              <span class="svc-check inline-flex items-center justify-center"
                ><CheckIcon size={12} weight="bold" /></span
              >
              <span
                class="svc-replay absolute inset-0 inline-flex items-center justify-center opacity-0"
                ><ArrowClockwiseIcon size={12} weight="bold" /></span
              >
            {:else}
              <PlayIcon size={11} weight="fill" />
            {/if}
          </button>

          <!-- Name opens the log dock (progressive disclosure). -->
          <button
            class="svc-main flex min-w-0 flex-1 cursor-pointer items-center rounded-md border-0 bg-transparent p-0.5 text-left"
            type="button"
            onclick={() => openLogs(run)}
          >
            <span
              class="svc-name min-w-0 overflow-hidden text-[0.8125rem] font-normal text-ellipsis whitespace-nowrap"
              title={run.command ?? undefined}
              >{runLabel(run)}</span
            >
          </button>

          <div class="svc-actions flex shrink-0 items-center gap-[0.1875rem]">
            {#if ports.length > 0}
              <!-- Tools sit just left of the port and reveal on hover, so the
                   port link stays flush-right and nothing shifts. -->
              <span class="svc-tools svc-tools--inflow inline-flex items-center gap-[0.1875rem] opacity-0">
                {@render tools(run, active)}
              </span>
              {#each ports as port (port)}
                <span
                  class="inline-flex"
                  use:tooltip={`Open http://localhost:${port}`}
                >
                  <Button
                    variant="secondary"
                    size="xs"
                    class="bg-(--solus-status-live-bg) text-(--solus-status-live) tabular-nums hover:bg-[color-mix(in_srgb,var(--solus-status-live)_18%,transparent)] hover:text-(--solus-status-live)"
                    type="button"
                    aria-label="Open http://localhost:{port}"
                    onclick={() => openPort(port)}
                  >
                    <ArrowSquareOutIcon size={10} /> :{port}
                  </Button>
                </span>
              {/each}
            {:else}
              <!-- Status word sits flush-right at rest and cross-fades to the
                   row's tools on hover (same reveal as the other panel rows). -->
              <span
                class="svc-trail relative inline-flex min-h-6 shrink-0 items-center"
              >
                {#if trailingText(run)}
                  <span
                    class="svc-status max-w-28 shrink-0 overflow-hidden text-[0.6875rem] text-ellipsis whitespace-nowrap tabular-nums"
                    class:err={run.state === "error"}
                    class:ok={run.state === "completed"}
                    title={run.state === "error"
                      ? (run.error ?? "exited unexpectedly")
                      : undefined}
                  >
                    {trailingText(run)}
                  </span>
                {/if}
                <span
                  class="svc-tools svc-tools--abs pointer-events-none absolute top-1/2 right-0 inline-flex -translate-y-1/2 items-center gap-[0.1875rem] opacity-0"
                >
                  {@render tools(run, active)}
                </span>
              </span>
            {/if}
          </div>
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  /* ============================================================
     Service rows — same quiet single-line menu language as the
     Environment (Git) section: flat, borderless, accent-light
     hover, 11px text / 12px icons, no heavy fills. State lives in
     the leading glyph and one trailing status word, not in chrome.
     ============================================================ */
  .svc-row {
    transition: background-color 0.15s ease;
  }
  .svc-row:hover {
    background: var(--solus-surface-hover);
  }

  /* ── Leading toggle (start / stop / cancel) ── */
  .svc-toggle {
    color: color-mix(in srgb, var(--project-icon-green) 78%, var(--solus-text-tertiary));
    transition:
      background-color 0.15s ease,
      color 0.15s ease,
      transform 0.15s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .svc-toggle:active {
    transform: scale(0.92);
  }
  .svc-toggle:focus-visible {
    outline: none;
    box-shadow: 0 0 0 0.125rem
      color-mix(in srgb, var(--solus-accent) 35%, transparent);
  }
  /* Stopped: a quiet play that warms to accent on hover. */
  .svc-toggle.state-stopped:hover {
    background: color-mix(in srgb, var(--project-icon-green) 14%, transparent);
    color: var(--project-icon-green);
  }
  /* Error: offer a fresh start, tinted to match the error state. */
  .svc-toggle.state-error {
    color: var(--solus-status-error);
  }
  .svc-toggle.state-error:hover {
    background: var(--solus-status-error-bg);
  }
  .svc-toggle.state-starting {
    color: var(--project-icon-blue);
  }

  /* Running: a steady glow dot at rest, becomes a stop control on hover. */
  .svc-dot {
    background: var(--solus-status-live);
  }
  @media (prefers-reduced-motion: no-preference) {
    .svc-toggle.state-running .svc-dot {
      animation: dot-pulse 2.4s cubic-bezier(0.4, 0, 0.6, 1) infinite;
    }
  }
  @keyframes dot-pulse {
    0%,
    100% {
      box-shadow: 0 0 0 0 var(--solus-status-live-glow);
    }
    50% {
      box-shadow: 0 0 0 0.1875rem transparent;
    }
  }
  .svc-stop {
    color: var(--solus-status-error);
  }
  .svc-toggle.state-running:hover {
    background: var(--solus-status-error-bg);
  }
  .svc-toggle.state-running:hover .svc-dot {
    opacity: 0;
  }
  .svc-toggle.state-running:hover .svc-stop,
  .svc-toggle.state-running:focus-visible .svc-stop {
    opacity: 1;
  }

  /* Completed: a green check at rest, becomes a replay control on hover. */
  .svc-toggle.state-completed {
    color: var(--solus-status-complete);
  }
  .svc-replay {
    color: var(--project-icon-blue);
  }
  .svc-toggle.state-completed:hover {
    background: color-mix(in srgb, var(--project-icon-blue) 14%, transparent);
  }
  .svc-toggle.state-completed:hover .svc-check {
    opacity: 0;
  }
  .svc-toggle.state-completed:hover .svc-replay,
  .svc-toggle.state-completed:focus-visible .svc-replay {
    opacity: 1;
  }

  /* ── Body (label) opens the log dock ── */
  .svc-main:focus-visible {
    outline: none;
    box-shadow: 0 0 0 0.125rem
      color-mix(in srgb, var(--solus-accent) 35%, transparent);
  }
  .svc-name {
    color: var(--solus-text-secondary);
    transition: color 0.15s ease;
  }
  .svc-row:hover .svc-name {
    color: var(--solus-text-primary);
  }
  /* Trailing status word — quiet at rest, fades out as the row's tools fade in. */
  .svc-status {
    color: var(--solus-text-tertiary);
    transition: opacity 0.15s ease;
  }
  .svc-row:hover .svc-status,
  .svc-trail:focus-within .svc-status {
    opacity: 0;
  }
  .svc-status.err {
    color: var(--solus-status-error);
  }
  .svc-status.ok {
    color: var(--solus-status-complete);
  }
  @media (prefers-reduced-motion: reduce) {
    .svc-status {
      transition: none;
    }
  }

  /* ── Trailing actions ── */
  /* Secondary controls stay out of sight until the row is engaged, so each
     service reads as a single calm line at rest and only reveals its tools
     on hover / keyboard focus — the same restraint as the Git section. The
     no-port variant overlays the status word (flush-right cross-fade); the
     port variant sits in-flow after the port pill. */
  .svc-tools--inflow {
    transition: opacity 0.15s ease;
  }
  .svc-tools--abs {
    transition: opacity 0.15s ease;
  }
  .svc-row:hover .svc-tools--inflow,
  .svc-tools--inflow:focus-within {
    opacity: 1;
  }
  .svc-row:hover .svc-tools--abs,
  .svc-tools--abs:focus-within {
    opacity: 1;
    pointer-events: auto;
  }
  @media (prefers-reduced-motion: reduce) {
    .svc-tools--inflow,
    .svc-tools--abs {
      transition: none;
    }
  }

  /* ── Empty state ── */
  .empty-cta {
    transition: background-color 0.15s ease;
  }
  .empty-cta:hover {
    background: var(--solus-surface-hover);
  }
  .empty-cta:focus-visible {
    outline: none;
    box-shadow: 0 0 0 0.125rem
      color-mix(in srgb, var(--solus-accent) 35%, transparent);
  }
  .empty-glyph {
    background: color-mix(in srgb, var(--solus-accent) 14%, transparent);
    color: var(--solus-accent);
  }
  .empty-title {
    color: var(--solus-text-primary);
  }
  .empty-sub {
    color: var(--solus-text-tertiary);
  }

  /* Shared glyph spin */
  @media (prefers-reduced-motion: no-preference) {
    .glyph-spin {
      animation: glyph-spin 0.7s linear infinite;
    }
  }
  @keyframes glyph-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
