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
  import { getRunStore } from "../../contexts/run.store.svelte";
  import { getRunDockStore } from "../../contexts/run-dock.store.svelte";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { getSettingsContext } from "../../contexts/settings.context.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { tooltip } from "../../lib/tooltip";
  import { fence, runLabel } from "../../lib/run-utils";
  import type { RunStatus } from "../../../shared/types";

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
    <button
      class="svc-icon"
      type="button"
      aria-label="Restart {runLabel(run)}"
      onclick={() => restartRun(run)}
      use:tooltip={`Restart ${runLabel(run)}`}
    >
      <ArrowClockwiseIcon size={12} />
    </button>
  {/if}
  {#if run.state === "error"}
    <button
      class="svc-icon svc-icon-agent"
      type="button"
      aria-label="Debug {runLabel(run)} with an agent"
      onclick={() => debugInNewSession(run)}
      use:tooltip={`Debug ${runLabel(run)} with an agent`}
    >
      <RobotIcon size={13} />
    </button>
  {/if}
  <button
    class="svc-icon"
    type="button"
    aria-label="Show logs for {runLabel(run)}"
    onclick={() => openLogs(run)}
    use:tooltip={`Show logs for ${runLabel(run)}`}
  >
    <ListBulletsIcon size={13} />
  </button>
{/snippet}

{#if runs.length === 0}
  <button class="empty-cta" type="button" onclick={onConfigure}>
    <span class="empty-glyph"><PlayIcon size={12} weight="fill" /></span>
    <span class="empty-copy">
      <span class="empty-title">No run command yet</span>
      <span class="empty-sub">Configure a command…</span>
    </span>
  </button>
{:else}
  <div class="run-list">
    {#each runs as run (run.commandId)}
      {@const active = isActive(run)}
      {@const ports = active ? run.ports : []}
      <div class="service">
        <div class="svc-row">
          <!-- Leading glyph IS the start / stop / cancel control. -->
          <button
            class="svc-toggle state-{run.state}"
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
              <span class="glyph-spin"><SpinnerGapIcon size={12} /></span>
            {:else if run.state === "running"}
              <span class="svc-dot"></span>
              <span class="svc-stop"><StopIcon size={11} weight="fill" /></span>
            {:else if run.state === "completed"}
              <span class="svc-check"><CheckIcon size={12} weight="bold" /></span>
              <span class="svc-replay"
                ><ArrowClockwiseIcon size={12} weight="bold" /></span
              >
            {:else}
              <PlayIcon size={11} weight="fill" />
            {/if}
          </button>

          <!-- Name opens the log dock (progressive disclosure). -->
          <button
            class="svc-main"
            type="button"
            onclick={() => openLogs(run)}
          >
            <span class="svc-name" title={run.command ?? undefined}
              >{runLabel(run)}</span
            >
          </button>

          <div class="svc-actions">
            {#if ports.length > 0}
              <!-- Tools sit just left of the port and reveal on hover, so the
                   port link stays flush-right and nothing shifts. -->
              <span class="svc-tools svc-tools--inflow">
                {@render tools(run, active)}
              </span>
              {#each ports as port (port)}
                <button
                  class="svc-url"
                  type="button"
                  aria-label="Open http://localhost:{port}"
                  onclick={() => openPort(port)}
                  use:tooltip={`Open http://localhost:${port}`}
                >
                  <ArrowSquareOutIcon size={10} /> :{port}
                </button>
              {/each}
            {:else}
              <!-- Status word sits flush-right at rest and cross-fades to the
                   row's tools on hover (same reveal as the other panel rows). -->
              <span class="svc-trail">
                {#if trailingText(run)}
                  <span
                    class="svc-status"
                    class:err={run.state === "error"}
                    class:ok={run.state === "completed"}
                    title={run.state === "error"
                      ? (run.error ?? "exited unexpectedly")
                      : undefined}
                  >
                    {trailingText(run)}
                  </span>
                {/if}
                <span class="svc-tools svc-tools--abs">
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
  .run-list {
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
  }

  .service {
    border-radius: 0.4375rem;
  }
  .svc-row {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-height: 2rem;
    padding: 0.1875rem 0.25rem 0.1875rem 0.1875rem;
    border-radius: 0.4375rem;
    transition: background-color 0.15s ease;
  }
  .svc-row:hover {
    background: var(--solus-accent-light);
  }

  /* ── Leading toggle (start / stop / cancel) ── */
  .svc-toggle {
    position: relative;
    width: 1.5rem;
    height: 1.5rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    border: none;
    border-radius: 999px;
    background: transparent;
    color: color-mix(in srgb, var(--project-icon-green) 78%, var(--solus-text-tertiary));
    cursor: pointer;
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
    width: 0.4375rem;
    height: 0.4375rem;
    border-radius: 999px;
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
    position: absolute;
    inset: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
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
  .svc-check {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .svc-replay {
    position: absolute;
    inset: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
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
  .svc-main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    padding: 0.125rem;
    border: none;
    background: transparent;
    text-align: left;
    cursor: pointer;
    border-radius: 0.375rem;
  }
  .svc-main:focus-visible {
    outline: none;
    box-shadow: 0 0 0 0.125rem
      color-mix(in srgb, var(--solus-accent) 35%, transparent);
  }
  .svc-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--solus-text-secondary);
    font-size: 0.8125rem;
    font-weight: 400;
    transition: color 0.15s ease;
  }
  .svc-row:hover .svc-name {
    color: var(--solus-text-primary);
  }
  /* Trailing status word — quiet at rest, fades out as the row's tools fade in. */
  .svc-status {
    flex-shrink: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 7rem;
    color: var(--solus-text-tertiary);
    font-size: 0.6875rem;
    font-variant-numeric: tabular-nums;
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
  .svc-actions {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 0.1875rem;
  }
  .svc-url {
    display: inline-flex;
    align-items: center;
    gap: 0.1875rem;
    padding: 0.125rem 0.375rem;
    border: none;
    border-radius: 999px;
    background: var(--solus-status-live-bg);
    color: var(--solus-status-live);
    font-size: 0.65625rem;
    font-weight: 550;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    transition: background-color 0.15s ease;
  }
  .svc-url:hover {
    background: color-mix(in srgb, var(--solus-status-live) 18%, transparent);
  }
  .svc-url:focus-visible {
    outline: none;
    box-shadow: 0 0 0 0.125rem
      color-mix(in srgb, var(--solus-accent) 35%, transparent);
  }
  .svc-icon {
    width: 1.5rem;
    height: 1.5rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 0.375rem;
    background: transparent;
    color: color-mix(in srgb, var(--project-icon-blue) 70%, var(--solus-text-tertiary));
    cursor: pointer;
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }
  .svc-icon:hover {
    background: color-mix(in srgb, var(--project-icon-blue) 12%, transparent);
    color: var(--project-icon-blue);
  }
  .svc-icon-agent {
    color: var(--project-icon-blue);
  }
  .svc-icon-agent:hover {
    background: color-mix(in srgb, var(--project-icon-blue) 12%, transparent);
    color: var(--project-icon-blue);
  }
  .svc-icon:focus-visible {
    outline: none;
    box-shadow: 0 0 0 0.125rem
      color-mix(in srgb, var(--solus-accent) 35%, transparent);
  }

  /* Secondary controls stay out of sight until the row is engaged, so each
     service reads as a single calm line at rest and only reveals its tools
     on hover / keyboard focus — the same restraint as the Git section. The
     no-port variant overlays the status word (flush-right cross-fade); the
     port variant sits in-flow after the port pill. */
  .svc-trail {
    position: relative;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    min-height: 1.5rem;
  }
  .svc-tools {
    display: inline-flex;
    align-items: center;
    gap: 0.1875rem;
  }
  .svc-tools--inflow {
    opacity: 0;
    transition: opacity 0.15s ease;
  }
  .svc-tools--abs {
    position: absolute;
    top: 50%;
    right: 0;
    transform: translateY(-50%);
    opacity: 0;
    pointer-events: none;
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
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.375rem 0.25rem;
    border: none;
    border-radius: 0.4375rem;
    background: transparent;
    text-align: left;
    cursor: pointer;
    transition: background-color 0.15s ease;
  }
  .empty-cta:hover {
    background: var(--solus-accent-light);
  }
  .empty-cta:focus-visible {
    outline: none;
    box-shadow: 0 0 0 0.125rem
      color-mix(in srgb, var(--solus-accent) 35%, transparent);
  }
  .empty-glyph {
    width: 1.5rem;
    height: 1.5rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    border-radius: 999px;
    background: color-mix(in srgb, var(--solus-accent) 14%, transparent);
    color: var(--solus-accent);
  }
  .empty-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
  }
  .empty-title {
    color: var(--solus-text-primary);
    font-size: 0.8125rem;
    font-weight: 500;
  }
  .empty-sub {
    color: var(--solus-text-tertiary);
    font-size: 0.6875rem;
  }

  /* Shared glyph spin */
  .glyph-spin {
    display: inline-flex;
  }
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
