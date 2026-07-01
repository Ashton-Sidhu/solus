<script lang="ts">
  import {
    CaretDoubleDownIcon,
    CheckIcon,
    CopyIcon,
    MagnifyingGlassIcon,
    PaperPlaneTiltIcon,
    PlusIcon,
    SpinnerGapIcon,
    XIcon,
  } from "phosphor-svelte";
  import { getRunStore } from "../../contexts/run.store.svelte";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { runLabel } from "../../lib/run-utils";
  import type {
    RunLogLevel,
    RunLogLine,
    RunStatus,
  } from "../../../shared/types";

  interface Props {
    cwd: string;
    run: RunStatus;
  }
  let { cwd, run }: Props = $props();

  const runStore = getRunStore();
  const session = getWorkspaceContext();
  const activeSession = $derived(session.sessionFor(session.activeTabId));

  const commandId = $derived(run.commandId);
  const logLines = $derived(runStore.logsFor(cwd, commandId) ?? []);
  const runDirectory = $derived(run.repoRoot || cwd);
  const runDirectoryLabel = $derived(shortPath(runDirectory));

  // Min-severity threshold: 'warn' includes errors; 'error' is errors only.
  type Severity = "all" | "warn" | "error";
  let severity = $state<Severity>("all");
  let filterText = $state("");

  const LEVEL_RANK: Record<RunLogLevel, number> = {
    info: 0,
    success: 0,
    warn: 1,
    error: 2,
  };
  const severityFloor = $derived(
    severity === "error" ? 2 : severity === "warn" ? 1 : 0,
  );
  // Single pass for both chips — each new streamed line invalidates this, so
  // walking logLines twice (once per count) doubled the per-line cost.
  const severityCounts = $derived.by(() => {
    let error = 0;
    let warn = 0;
    for (const l of logLines) {
      if (l.level === "error") error++;
      else if (l.level === "warn") warn++;
    }
    return { error, warn: warn + error };
  });
  const errorCount = $derived(severityCounts.error);
  const warnCount = $derived(severityCounts.warn);

  // Severity chips toggle their own filter off when re-pressed.
  function toggleSeverity(s: "warn" | "error") {
    severity = severity === s ? "all" : s;
  }

  // Lines are immutable once captured, so cache their lowercased text by
  // reference — otherwise every keystroke re-lowercases the entire buffer.
  const lowerCache = new WeakMap<RunLogLine, string>();
  function lowerText(line: RunLogLine): string {
    let lower = lowerCache.get(line);
    if (lower === undefined) {
      lower = line.text.toLowerCase();
      lowerCache.set(line, lower);
    }
    return lower;
  }

  const visibleLines = $derived.by(() => {
    const needle = filterText.trim().toLowerCase();
    return logLines.filter((l) => {
      if (LEVEL_RANK[l.level] < severityFloor) return false;
      if (needle && !lowerText(l).includes(needle)) return false;
      return true;
    });
  });

  // ── Row presentation ──
  const GLYPH: Record<RunLogLevel, string> = {
    error: "✕",
    warn: "⚠",
    success: "✓",
    info: "·",
  };

  function formatTime(ts: number): string {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  // Light tokenisation: only URLs and file paths get syntax colour. Numbers are
  // intentionally left alone — the number token shares the warn colour and would
  // muddy severity scanning.
  const ESC: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
  };
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ESC[c]);
  const TOKEN_RE =
    /(https?:\/\/[^\s)]+)|([\w./-]*\.(?:svelte|ts|tsx|js|jsx|mjs|cjs|css|json|html)(?::\d+(?::\d+)?)?)/g;

  function tokenize(text: string): string {
    let out = "";
    let last = 0;
    let m: RegExpExecArray | null;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(text)) !== null) {
      out += esc(text.slice(last, m.index));
      out += `<span class="${m[1] ? "tok-url" : "tok-path"}">${esc(m[0])}</span>`;
      last = m.index + m[0].length;
    }
    out += esc(text.slice(last));
    return out;
  }

  // Lines are immutable once captured, so cache the rendered HTML by reference.
  const tokenCache = new WeakMap<RunLogLine, string>();
  function renderLine(line: RunLogLine): string {
    let html = tokenCache.get(line);
    if (html === undefined) {
      html = tokenize(line.text);
      tokenCache.set(line, html);
    }
    return html;
  }

  let copied = $state(false);

  // ── Terminal-style text selection ──
  // The message column is plain selectable text (the time/glyph gutter opts out
  // of selection so a drag copies only the log body). Toolbar actions operate on
  // the live highlight when there is one, else on every visible line — so there's
  // no per-row chrome to maintain and selection scales to any number of lines.
  let selectionLineCount = $state(0);
  const hasSelection = $derived(selectionLineCount > 0);

  $effect(() => {
    const onChange = () => {
      const sel = window.getSelection();
      const inConsole =
        !!sel &&
        !sel.isCollapsed &&
        !!consoleEl &&
        !!sel.anchorNode &&
        consoleEl.contains(sel.anchorNode);
      const text = inConsole ? (sel?.toString().trim() ?? "") : "";
      selectionLineCount = text ? text.split("\n").length : 0;
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  });

  // Text the toolbar actions act on: the highlight if present, else all visible.
  function actionText(): string {
    if (hasSelection) {
      const t = window.getSelection()?.toString().trim();
      if (t) return t;
    }
    return visibleLines.map((l) => l.text).join("\n");
  }

  // Auto-scroll: stay pinned to the tail unless the user scrolls up.
  let consoleEl = $state<HTMLDivElement>();
  let pinned = $state(true);

  const isStarting = $derived(
    run.state === "starting" || run.state === "running",
  );

  // Seed the buffer once (covers output from before we subscribed).
  $effect(() => {
    if (commandId) void runStore.backfillLogs(cwd, commandId);
  });

  // Keep pinned to the newest line as logs stream in (or the filter changes).
  $effect(() => {
    void visibleLines.length;
    if (pinned && consoleEl) consoleEl.scrollTop = consoleEl.scrollHeight;
  });

  function onConsoleScroll() {
    if (!consoleEl) return;
    const distanceFromBottom =
      consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight;
    pinned = distanceFromBottom < 24;
  }

  function jumpToLatest() {
    if (!consoleEl) return;
    consoleEl.scrollTop = consoleEl.scrollHeight;
    pinned = true;
  }

  function copyText(text: string) {
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      copied = true;
      setTimeout(() => (copied = false), 1500);
    });
  }

  function copyLogs() {
    copyText(actionText());
    requestInputFocus();
  }

  function shortPath(path: string): string {
    const home = session.staticInfo?.homePath;
    const trimmed = path.replace(/\/$/, "");
    if (home && trimmed === home) return "~";
    if (home && trimmed.startsWith(`${home}/`))
      return `~/${trimmed.slice(home.length + 1)}`;
    return trimmed;
  }

  function fenced(text: string): string {
    return ["```", text, "```"].join("\n");
  }

  function sendToChat() {
    const text = actionText();
    if (!text) return;
    const count = text.split("\n").length;
    const prompt = [
      `Here ${count === 1 ? "is" : "are"} ${count} log line${count === 1 ? "" : "s"} from \`${runLabel(run)}\`:`,
      "",
      fenced(text),
    ].join("\n");
    session.sendMessage(prompt);
    requestInputFocus();
  }

  async function newSessionFromLogs() {
    const text = actionText();
    if (!text) return;
    const prompt = [
      `Look at these log lines from my run command \`${runLabel(run)}\`:`,
      "",
      fenced(text),
    ].join("\n");
    await session.startNewSessionWithPrompt(
      prompt,
      activeSession?.workingDirectory ?? cwd,
      activeSession?.gitContext ?? null,
    );
    requestInputFocus();
  }
</script>

<div class="console" role="region" aria-label="Run log panel">
  <div class="console-toolbar">
    <label class="filter">
      <MagnifyingGlassIcon size={12} />
      <input
        data-run-log-filter
        type="text"
        placeholder="Filter logs…"
        bind:value={filterText}
        spellcheck={false}
        aria-label="Filter log lines"
      />
      {#if filterText}
        <button
          class="filter-clear"
          type="button"
          aria-label="Clear filter"
          onclick={() => (filterText = "")}
        >
          <XIcon size={11} />
        </button>
      {/if}
    </label>
    <div class="sev-cluster" role="group" aria-label="Severity filter">
      <button
        type="button"
        class="sev-chip err"
        class:active={severity === "error"}
        class:muted={errorCount === 0}
        aria-pressed={severity === "error"}
        title="Errors only"
        onclick={() => toggleSeverity("error")}
      >
        <span class="gl">✕</span>{errorCount}
      </button>
      <button
        type="button"
        class="sev-chip warn"
        class:active={severity === "warn"}
        class:muted={warnCount === 0}
        aria-pressed={severity === "warn"}
        title="Warnings & errors"
        onclick={() => toggleSeverity("warn")}
      >
        <span class="gl">⚠</span>{warnCount}
      </button>
    </div>
  </div>

  <div class="console-scroll">
    <div
      class="console-body"
      bind:this={consoleEl}
      onscroll={onConsoleScroll}
      role="log"
      aria-label="Run logs for {runLabel(run)}"
    >
      {#if logLines.length === 0}
        {#if isStarting}
          <div class="console-empty starting">
            <span class="empty-spinner"
              ><SpinnerGapIcon size={20} weight="bold" /></span
            >
            <span class="empty-title">Starting {runLabel(run)}…</span>
            {#if run.command}
              <code class="empty-cmd"
                ><span class="empty-cmd-prompt">$</span> {run.command}</code
              >
            {/if}
            <div class="shimmer" aria-hidden="true">
              <span></span><span></span><span></span>
            </div>
          </div>
        {:else}
          <div class="console-empty">
            <span class="empty-title">No output</span>
            <span class="empty-sub"
              >{runLabel(run)} hasn't produced any output.</span
            >
          </div>
        {/if}
      {:else if visibleLines.length === 0}
        <div class="console-empty">
          <span class="empty-title">No matching lines</span>
          <span class="empty-sub">Try a different filter or severity.</span>
        </div>
      {:else}
        {#each visibleLines as line (line.seq)}
          <div class="log-line level-{line.level}" data-seq={line.seq}>
            <span class="ln-gutter" aria-hidden="true">
              <span class="ln-time">{formatTime(line.ts)}</span>
              <span class="ln-glyph">{GLYPH[line.level]}</span>
            </span>
            <span class="ln-msg">{@html renderLine(line)}</span>
          </div>
        {/each}
      {/if}
    </div>

    {#if !pinned && logLines.length > 0}
      <button
        type="button"
        class="jump-latest"
        onclick={jumpToLatest}
        title="Jump to latest"
        aria-label="Jump to latest output"
      >
        <CaretDoubleDownIcon size={13} weight="bold" />
      </button>
    {/if}
  </div>

  {#if logLines.length > 0}
    <div class="console-status">
      <div class="status-left">
        <button
          type="button"
          class="live-tag"
          class:paused={!pinned}
          onclick={jumpToLatest}
          title={pinned ? "Following latest output" : "Jump to latest"}
        >
          {pinned ? "Live" : "Paused"}
        </button>
        <span class="status-count">
          {#if hasSelection}
            {selectionLineCount} selected
          {:else if visibleLines.length === logLines.length}
            {logLines.length} line{logLines.length === 1 ? "" : "s"}
          {:else}
            {visibleLines.length} of {logLines.length} lines
          {/if}
        </span>
        <div
          class="status-cwd"
          title={runDirectory}
          aria-label="Command directory"
        >
          <span class="status-cwd-path">{runDirectoryLabel}</span>
        </div>
      </div>
      <div class="status-actions">
        <button
          type="button"
          class="status-action"
          onclick={copyLogs}
          title={hasSelection ? "Copy selection" : "Copy all logs"}
        >
          {#if copied}
            <CheckIcon size={12} /> <span class="status-action-label">Copied</span>
          {:else}
            <CopyIcon size={12} /> <span class="status-action-label">Copy</span>
          {/if}
        </button>
        <button
          type="button"
          class="status-action"
          onclick={sendToChat}
          title={hasSelection ? "Send selection to chat" : "Send logs to chat"}
        >
          <PaperPlaneTiltIcon size={12} />
          <span class="status-action-label">Send to chat</span>
        </button>
        <button
          type="button"
          class="status-action"
          onclick={newSessionFromLogs}
          title={hasSelection
            ? "New session from selection"
            : "New session from logs"}
        >
          <PlusIcon size={12} />
          <span class="status-action-label">New session</span>
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .console {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
    /* Background comes from the dock card (.run-dock); stay transparent so the
       recessed surface shows through. */
    background: transparent;
    /* Layout responds to the dock's own width (split panes, pill mode, window
       resize), not the viewport — so drive the breakpoints off the container. */
    container: log-console / inline-size;
  }

  /* ── Toolbar: filter + severity ── */
  .console-toolbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.4375rem;
    padding: 0.4375rem 0.625rem;
    border-bottom: 1px solid
      color-mix(in srgb, var(--solus-text-tertiary) 14%, transparent);
    flex-shrink: 0;
  }
  .filter {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.5rem;
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--solus-text-tertiary) 8%, transparent);
    border: 1px solid transparent;
    color: var(--solus-text-tertiary);
    transition:
      border-color 0.12s ease,
      background 0.12s ease;
  }
  .filter:focus-within {
    border-color: var(--solus-accent-soft);
    background: color-mix(in srgb, var(--solus-text-tertiary) 4%, transparent);
  }
  .filter input {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    outline: none;
    color: var(--solus-text-primary);
    font-family: var(--solus-font-family);
    font-size: 0.6875rem;
  }
  .filter input::placeholder {
    color: var(--solus-text-tertiary);
  }
  .filter-clear {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    padding: 0;
  }
  .filter-clear:hover {
    color: var(--solus-text-primary);
  }

  /* Severity summary chips — always-visible counts that double as filters. */
  .sev-cluster {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
  }
  .sev-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    padding: 0.25rem 0.5rem;
    border: none;
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--solus-text-tertiary) 8%, transparent);
    font-family: inherit;
    font-size: 0.625rem;
    font-weight: 650;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    transition:
      background 0.12s ease,
      color 0.12s ease;
  }
  .sev-chip .gl {
    font-weight: 700;
  }
  .sev-chip.err {
    color: var(--solus-status-error);
  }
  .sev-chip.warn {
    color: var(--solus-syntax-number);
  }
  .sev-chip:hover {
    background: color-mix(in srgb, var(--solus-text-tertiary) 14%, transparent);
  }
  .sev-chip.err.active {
    background: var(--solus-status-error-bg);
  }
  .sev-chip.warn.active {
    background: color-mix(in srgb, var(--solus-syntax-number) 16%, transparent);
  }
  .sev-chip.muted {
    color: var(--solus-text-tertiary);
    opacity: 0.6;
  }
  .sev-chip:focus-visible {
    outline: none;
    box-shadow: 0 0 0 0.125rem
      color-mix(in srgb, var(--solus-accent) 35%, transparent);
  }

  /* ── Log body ── */
  .console-scroll {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .console-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    padding: 0.25rem 0;
    scrollbar-width: thin;
  }
  .console-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    padding: 1.5rem 1rem;
    text-align: center;
  }
  .console-empty.starting {
    gap: 0.625rem;
  }
  .empty-spinner {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.5rem;
    height: 2.5rem;
    border-radius: 0.75rem;
    background: var(--solus-accent-light);
    color: var(--solus-accent);
  }
  .empty-spinner :global(svg) {
    animation: log-spin 1s linear infinite;
  }
  @keyframes log-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .empty-title {
    color: var(--solus-text-primary);
    font-size: 0.75rem;
    font-weight: 600;
  }
  .console-empty:not(.starting) .empty-title {
    color: var(--solus-text-secondary);
  }
  .empty-sub {
    color: var(--solus-text-tertiary);
    font-size: 0.6875rem;
  }
  .empty-cmd {
    font-family: var(--solus-code-font-family);
    font-size: 0.6875rem;
    color: var(--solus-text-secondary);
    background: color-mix(in srgb, var(--solus-text-tertiary) 10%, transparent);
    padding: 0.25rem 0.5rem;
    border-radius: 0.5rem;
  }
  .empty-cmd-prompt {
    color: var(--solus-accent);
  }
  .shimmer {
    display: flex;
    flex-direction: column;
    gap: 0.4375rem;
    width: 12rem;
    margin-top: 0.25rem;
  }
  .shimmer span {
    height: 0.4375rem;
    border-radius: 999px;
    background: linear-gradient(
      90deg,
      color-mix(in srgb, var(--solus-text-tertiary) 10%, transparent) 25%,
      color-mix(in srgb, var(--solus-text-tertiary) 22%, transparent) 37%,
      color-mix(in srgb, var(--solus-text-tertiary) 10%, transparent) 63%
    );
    background-size: 400% 100%;
    animation: shimmer 1.4s ease infinite;
  }
  .shimmer span:nth-child(1) {
    width: 100%;
  }
  .shimmer span:nth-child(2) {
    width: 70%;
  }
  .shimmer span:nth-child(3) {
    width: 85%;
  }
  @keyframes shimmer {
    0% {
      background-position: 100% 0;
    }
    100% {
      background-position: 0 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .empty-spinner :global(svg),
    .shimmer span {
      animation: none;
    }
  }

  .log-line {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: baseline;
    gap: 0.5rem;
    width: 100%;
    text-align: left;
    border-left: 0.125rem solid transparent;
    padding: 0.0625rem 0.75rem 0.0625rem 0.625rem;
    color: var(--solus-text-secondary);
    font-family: var(--solus-code-font-family);
    font-size: 0.6875rem;
    line-height: 1.65;
  }
  .ln-gutter {
    display: inline-flex;
    align-items: baseline;
    gap: 0.5rem;
    /* The gutter opts out of selection so a drag copies only the message text. */
    user-select: none;
  }
  .ln-time {
    color: var(--solus-text-tertiary);
    opacity: 0.65;
    font-size: 0.625rem;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .ln-glyph {
    font-weight: 700;
    color: var(--solus-text-tertiary);
  }
  .ln-msg {
    min-width: 0;
    white-space: pre-wrap;
    word-break: break-word;
    user-select: text;
  }
  .ln-msg :global(.tok-url) {
    color: var(--solus-syntax-function);
    text-decoration: underline;
    text-underline-offset: 2px;
    text-decoration-color: color-mix(
      in srgb,
      var(--solus-syntax-function) 40%,
      transparent
    );
  }
  .ln-msg :global(.tok-path) {
    color: var(--solus-syntax-function);
  }
  .log-line.level-error {
    color: var(--solus-status-error);
    background: var(--solus-status-error-bg);
    border-left-color: color-mix(
      in srgb,
      var(--solus-status-error) 55%,
      transparent
    );
  }
  .log-line.level-error .ln-glyph {
    color: var(--solus-status-error);
  }
  .log-line.level-warn {
    color: color-mix(
      in srgb,
      var(--solus-syntax-number) 88%,
      var(--solus-text-secondary)
    );
    border-left-color: color-mix(
      in srgb,
      var(--solus-syntax-number) 45%,
      transparent
    );
  }
  .log-line.level-warn .ln-glyph {
    color: var(--solus-syntax-number);
  }
  .log-line.level-success .ln-glyph {
    color: var(--solus-syntax-addition);
  }
  /* Keep tokenised colour from overpowering an error/warn line's own hue. */
  .log-line.level-error .ln-msg :global(.tok-url),
  .log-line.level-error .ln-msg :global(.tok-path),
  .log-line.level-warn .ln-msg :global(.tok-url),
  .log-line.level-warn .ln-msg :global(.tok-path) {
    color: inherit;
  }

  /* ── Jump to latest ── */
  .jump-latest {
    position: absolute;
    right: 0.625rem;
    bottom: 0.625rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    border: 1px solid
      color-mix(in srgb, var(--solus-text-tertiary) 16%, transparent);
    border-radius: 999px;
    background: var(--solus-input-bg-soft);
    color: var(--solus-text-secondary);
    cursor: pointer;
    box-shadow: 0 0.125rem 0.5rem rgba(0, 0, 0, 0.18);
    transition:
      background 0.12s ease,
      color 0.12s ease,
      transform 0.12s ease;
  }
  .jump-latest:hover {
    background: var(--solus-accent);
    border-color: transparent;
    color: #fff;
    transform: translateY(-0.0625rem);
  }
  .jump-latest:focus-visible {
    outline: none;
    box-shadow: 0 0 0 0.125rem
      color-mix(in srgb, var(--solus-accent) 35%, transparent);
  }

  /* ── Status bar ── */
  .console-status {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.3125rem 0.5rem 0.3125rem 0.5rem;
    border-top: 1px solid
      color-mix(in srgb, var(--solus-text-tertiary) 14%, transparent);
  }
  .status-left {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  .live-tag {
    display: inline-flex;
    align-items: center;
    border: none;
    background: transparent;
    padding: 0.125rem 0.375rem;
    border-radius: 0.375rem;
    font-family: inherit;
    font-size: 0.625rem;
    font-weight: 650;
    letter-spacing: 0.01em;
    color: var(--solus-status-live);
    cursor: default;
  }
  .live-tag.paused {
    color: var(--solus-text-tertiary);
    cursor: pointer;
  }
  .live-tag.paused:hover {
    color: var(--solus-text-primary);
    background: color-mix(in srgb, var(--solus-text-tertiary) 10%, transparent);
  }
  .live-tag:focus-visible {
    outline: none;
    box-shadow: 0 0 0 0.125rem
      color-mix(in srgb, var(--solus-accent) 35%, transparent);
  }
  .status-count {
    color: var(--solus-text-tertiary);
    font-size: 0.625rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .status-cwd {
    min-width: 0;
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    overflow: hidden;
    color: var(--solus-text-tertiary);
    font-family: var(--solus-code-font-family);
    font-size: 0.625rem;
  }
  .status-cwd-path {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--solus-text-secondary);
  }
  .status-actions {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 0.125rem;
  }
  .status-action {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.1875rem 0.375rem;
    border: none;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--solus-text-tertiary);
    font-size: 0.625rem;
    font-weight: 550;
    cursor: pointer;
    transition:
      background 0.12s ease,
      color 0.12s ease;
  }
  .status-action:hover {
    background: color-mix(in srgb, var(--solus-text-tertiary) 10%, transparent);
    color: var(--solus-text-primary);
  }
  .status-action:focus-visible {
    outline: none;
    box-shadow: 0 0 0 0.125rem
      color-mix(in srgb, var(--solus-accent) 35%, transparent);
  }

  /* ── Narrow dock: collapse labelled controls to icon-only ──
     The status bar (Live + count + directory + three actions) is the first
     thing to overflow when the dock is split or pulled narrow. Drop the
     least-essential text so the controls stay tappable instead of clipping.
     Titles keep the icons self-explanatory. */
  @container log-console (max-width: 30rem) {
    .status-action-label {
      display: none;
    }
    .status-action {
      padding: 0.1875rem;
    }
  }
  @container log-console (max-width: 18rem) {
    .status-cwd {
      display: none;
    }
  }
</style>
