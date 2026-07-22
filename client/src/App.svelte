<script lang="ts">
  import { untrack } from "svelte";
  import { DownloadSimpleIcon } from "phosphor-svelte";
  import { setPopoverLayer } from "@renderer/components/popoverLayer.svelte";
  import {
    savePersistedTabs,
    saveDraftsDebounced,
    flushDrafts,
    type PersistedTabs,
  } from "@renderer/contexts/workspace/tab-persistence";
  import { setupAgentEvents } from "@renderer/hooks/agentEvents.svelte";
  import { materializeTabs } from "@renderer/contexts/workspace/session-bootstrap";
  import {
    createReconnectDetector,
    initializeRuntime,
    refreshTheme,
  } from "@renderer/contexts/app/runtime-boot";
  import { createAppCore } from "@renderer/contexts/app/app-core";
  import { connectionsStore } from "@renderer/contexts";
  import { webState } from "./lib/web-state.svelte";
  import {
    useKeybinding,
    installGlobalDispatcher,
  } from "@renderer/lib/keybindings/use-keybinding.svelte";
  import { requestInputFocus } from "@renderer/lib/inputFocus";
  import { invalidateHomeCache } from "@renderer/components/layout/NewTabHome.svelte";
  import WebLayout from "./components/WebLayout.svelte";

  const { settings, planStore, runStore, sessionSidebarStore, session, agent, keybindings } =
    createAppCore();

  // Materialize tabs synchronously during component init — before first paint — so
  // the tab strip, titles, drafts, and active tab render in the first mounted frame
  // with zero server round trips. Cached start() is applied first so persisted tabs
  // can fall back to the last known workspace path. The async runtime attach and
  // fresh start() reconciliation run later from the effect below.
  session.hydrateStaticInfoFromCache();
  materializeTabs(session);

  // Persist open-tab snapshot to localStorage so it survives refresh and cold restarts.
  // Reads only the persisted fields, so it won't re-run on message streaming.
  // Skipped while bootstrap is in progress so an empty initial state doesn't clobber saved data.
  $effect(() => {
    if (session.hydrating) return;
    const tabs = session.tabOrder
      .filter((id) => session.tabs[id])
      .map((tabId) => {
        const tab = session.tabs[tabId];
        const sess = session.sessionFor(tabId);
        return {
          tabId,
          title: tab.title ?? "New Tab",
          agentSessionId: sess?.agentSessionId ?? null,
          provider: sess?.provider ?? null,
          workingDirectory: sess?.workingDirectory ?? session.globalDefaults.workingDirectory,
          additionalDirs: sess ? [...sess.additionalDirs] : [],
          gitContext: sess?.gitContext ? { ...sess.gitContext } : null,
          worktreeBaseBranch: sess?.worktreeBaseBranch ?? null,
          modelConfig: sess ? { ...sess.modelConfig } : { ...session.globalDefaults.modelConfig },
          permissionMode: sess?.permissionMode ?? session.globalDefaults.permissionMode,
          hasUnread: tab.hasUnread ?? false,
        };
      });
    const snapshot: PersistedTabs = {
      version: 1,
      activeTabId: session.activeTabId,
      tabOrder: [...session.tabOrder],
      tabs,
    };
    savePersistedTabs(snapshot);
  });

  // Unsent input drafts persist separately on a debounce. This effect re-runs on
  // every keystroke but only collects strings — no object spreads, no I/O until
  // the debounce settles — so the structural snapshot above stays keystroke-free.
  $effect(() => {
    if (session.hydrating) return;
    const tabs: Record<string, string> = {};
    for (const tabId of session.tabOrder) {
      const tab = session.tabs[tabId];
      if (tab) tabs[tabId] = tab.input.text;
    }
    saveDraftsDebounced({ activeInputText: session.activeInput.text, tabs });
  });

  // Flush pending drafts before the window unloads so the latest keystrokes survive.
  $effect(() => {
    const flush = () => flushDrafts();
    window.addEventListener("pagehide", flush);
    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
    };
  });

  // Slash command discovery is backend-scoped, so refresh when the active agent changes.
  // untrack the directory so this doesn't re-run on every session mutation.
  $effect(() => {
    void settings.activeAgent;
    void session.refreshPluginCommands(untrack(() => session.tabCtx.workingDirectory));
  });

  setupAgentEvents(session);

  let overlayEl: HTMLElement | null = $state(null);
  setPopoverLayer({
    get el() {
      return overlayEl;
    },
  });

  let directoryPickerOpen = $state(false);
  let shortcutsModalOpen = $state(false);
  let hasMountedDirectoryPicker = $state(false);
  let hasMountedShortcuts = $state(false);
  let shortcutsActiveScopes = $state<import("@renderer/lib/keybindings/types").Scope[]>([]);

  $effect(() => {
    if (directoryPickerOpen) hasMountedDirectoryPicker = true;
    if (shortcutsModalOpen) hasMountedShortcuts = true;
  });

  const activeTabId = $derived(session.activeTabId);
  const isRunning = $derived.by(() => {
    const s = session.activeSession?.status;
    return s === "running" || s === "connecting";
  });

  // Keyboard next/prev follows the order WebLayout actually renders: raw tabOrder.
  const visualTabOrder: string[] = $derived(
    session.tabOrder.filter((id) => session.tabs[id]),
  );
  const permissionMode = $derived(
    session.activeSession?.permissionMode ?? "auto",
  );

  $effect(() => {
    refreshTheme(settings.setSystemTheme.bind(settings));
    const unsub = window.solus.onThemeChange((isDark: boolean) =>
      settings.setSystemTheme(isDark),
    );
    return unsub;
  });

  $effect(() => {
    const unsubRun = window.solus.onRunStatus((status) => runStore.apply(status));
    const unsubRunLog = window.solus.onRunLog((batch) => runStore.applyLog(batch));
    return () => {
      unsubRun();
      unsubRunLog();
    };
  });

  $effect(() => {
    const handler = (event: Event) => {
      const sessionId = (event as CustomEvent<{ sessionId?: string | null }>).detail?.sessionId;
      if (!sessionId) return;
      const tabId = session.tabOrder.find((candidate) => {
        const candidateSession = session.sessionFor(candidate);
        return candidateSession?.agentSessionId === sessionId ||
          candidateSession?.forkedFromSessionId === sessionId;
      });
      if (tabId) session.selectTab(tabId);
      requestInputFocus();
    };
    window.addEventListener("solus:focus-session", handler);
    return () => window.removeEventListener("solus:focus-session", handler);
  });

  $effect(() => {
    initializeRuntime(session, sessionSidebarStore);
  });

  $effect(() => {
    void connectionsStore.refreshCapabilities();
  });

  const detectReconnect = createReconnectDetector(webState.connectionStatus);
  $effect(() => {
    const connectionStatus = webState.connectionStatus;
    if (detectReconnect(connectionStatus)) {
      refreshTheme(settings.setSystemTheme.bind(settings));
      initializeRuntime(session, sessionSidebarStore);
      void connectionsStore.refreshCapabilities();
    }
  });

  // ── Keybindings ──────────────────────────────────────────────────────────
  installGlobalDispatcher(keybindings, () => settings.keybindings);

  useKeybinding("global.select-project", () => {
    if (isRunning) return;
    directoryPickerOpen = true;
  });
  useKeybinding("global.new-tab", () => session.createTab());
  useKeybinding("global.next-tab", () => {
    const idx = visualTabOrder.indexOf(activeTabId);
    if (idx !== -1)
      session.selectTab(visualTabOrder[(idx + 1) % visualTabOrder.length]);
  });
  useKeybinding("global.prev-tab", () => {
    const idx = visualTabOrder.indexOf(activeTabId);
    if (idx !== -1)
      session.selectTab(
        visualTabOrder[
          (idx - 1 + visualTabOrder.length) % visualTabOrder.length
        ],
      );
  });
  useKeybinding("global.next-session", () => {
    const idx = visualTabOrder.indexOf(activeTabId);
    if (idx !== -1)
      session.selectTab(visualTabOrder[(idx + 1) % visualTabOrder.length]);
  });
  useKeybinding("global.prev-session", () => {
    const idx = visualTabOrder.indexOf(activeTabId);
    if (idx !== -1)
      session.selectTab(
        visualTabOrder[
          (idx - 1 + visualTabOrder.length) % visualTabOrder.length
        ],
      );
  });
  useKeybinding("global.session-picker", () =>
    window.dispatchEvent(new CustomEvent("solus:toggle-session-picker")),
  );
  useKeybinding("global.session-picker-j", () =>
    window.dispatchEvent(new CustomEvent("solus:toggle-session-picker")),
  );
  useKeybinding("global.cycle-perm-mode", () => {
    const modes = ["ask", "auto", "plan"] as const;
    const next =
      modes[
        (modes.indexOf(permissionMode as (typeof modes)[number]) + 1) %
          modes.length
      ];
    session.setPermissionMode(next);
  });
  useKeybinding("global.close-tab", () => {
    if (activeTabId) session.closeTab(activeTabId);
  });
  useKeybinding("global.attach-file", handleAttachFile);
  useKeybinding("global.cycle-agent", async () => {
    if (!isRunning) await cycleAgentProvider();
  });
  useKeybinding("global.cycle-model", () => {
    if (isRunning) return;
    const models = agent.activeMetadata?.models;
    if (!models || models.length === 0) return;
    const defaultModel = agent.activeMetadata?.defaultModel;
    const currentModel =
      session.activeSession?.modelConfig.modelId ??
      session.activeSession?.sessionModel ??
      defaultModel ??
      models[0].id;
    const idx = models.findIndex((m) => m.id === currentModel);
    session.updateModelConfig({
      modelId: models[((idx === -1 ? 0 : idx) + 1) % models.length].id,
    });
  });
  useKeybinding("global.toggle-reasoning", () => {
    if (isRunning) return;
    window.dispatchEvent(new CustomEvent("solus:toggle-session-settings-picker"));
  });
  useKeybinding("global.toggle-diff-panel", () =>
    window.dispatchEvent(new CustomEvent("solus:toggle-diff-panel")),
  );
  useKeybinding("global.toggle-plans", () => session.togglePlansGallery());
  useKeybinding("global.toggle-folio", () => session.toggleFolioGallery());
  useKeybinding("global.focus-input", () => requestInputFocus());
  useKeybinding("global.toggle-worktree", () => session.toggleWorktreeMode());
  useKeybinding("global.switch-worktree", () => {
    if (session.activeSession?.agentSessionId) return;
    window.dispatchEvent(new CustomEvent("solus:toggle-git-dropdown"));
  });
  useKeybinding("global.show-shortcuts", () => {
    shortcutsActiveScopes = keybindings.activeScopes();
    shortcutsModalOpen = true;
  });

  $effect(() => {
    const handler = () => {
      if (!isRunning) directoryPickerOpen = true;
    };
    window.addEventListener("solus:open-directory-picker", handler);
    return () =>
      window.removeEventListener("solus:open-directory-picker", handler);
  });

  async function handleDirectorySelected(dir: string) {
    directoryPickerOpen = false;
    invalidateHomeCache();
    await session.setBaseDirectory(dir);
    requestInputFocus();
  }

  function handleDirectoryPickerClose() {
    directoryPickerOpen = false;
    requestInputFocus();
  }

  async function handleAttachFile(tabId?: string) {
    const files = await window.solus.attachFiles();
    if (!files || files.length === 0) return;
    session.addAttachments(files, tabId);
  }

  async function cycleAgentProvider() {
    const enabledAgents = agent.agents.filter(
      (candidate) => agent.metadata[candidate.id]?.available === true,
    );
    if (enabledAgents.length <= 1) return;

    const currentAgent =
      session.activeSession?.provider ?? settings.activeAgent;
    const idx = enabledAgents.findIndex(
      (candidate) => candidate.id === currentAgent,
    );
    const next = enabledAgents[(idx + 1) % enabledAgents.length];
    session.switchActiveAgent(next.id);
  }

  let isDraggingFile = $state(false);
  let dragCounter = 0;

  $effect(() => {
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      dragCounter++;
      isDraggingFile = true;
    };
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        isDraggingFile = false;
      }
    };
    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      dragCounter = 0;
      isDraggingFile = false;
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const attachments = await (window.solus as any).uploadFiles(Array.from(files));
      if (attachments) session.addAttachments(attachments);
    };
    document.addEventListener("dragenter", onDragEnter);
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("dragleave", onDragLeave);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragenter", onDragEnter);
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("dragleave", onDragLeave);
      document.removeEventListener("drop", onDrop);
    };
  });
</script>

<div
  bind:this={overlayEl}
  data-solus-ui
  class="click-through-shell"
  style="position:fixed;inset:0;z-index:10010"
></div>

<div class="flex h-full w-full" style="background:var(--solus-container-bg);">
  <WebLayout onAttachFile={handleAttachFile} />
</div>

{#if hasMountedDirectoryPicker}
  {#await import("@renderer/components/pickers/DirectoryPicker.svelte")}
    {#if directoryPickerOpen}
      <div class="lazy-modal-loading" role="status">Loading folders…</div>
    {/if}
  {:then directoryPickerModule}
    {@const DirectoryPicker = directoryPickerModule.default}
    <DirectoryPicker
      bind:open={directoryPickerOpen}
      onClose={handleDirectoryPickerClose}
      onSelect={handleDirectorySelected}
    />
  {/await}
{/if}

{#if hasMountedShortcuts}
  {#await import("@renderer/components/KeyboardShortcutsModal.svelte")}
    {#if shortcutsModalOpen}
      <div class="lazy-modal-loading" role="status">Loading shortcuts…</div>
    {/if}
  {:then shortcutsModule}
    {@const KeyboardShortcutsModal = shortcutsModule.default}
    <KeyboardShortcutsModal
      bind:open={shortcutsModalOpen}
      activeScopes={shortcutsActiveScopes}
    />
  {/await}
{/if}

{#if isDraggingFile}
  <div data-solus-ui class="drop-overlay">
    <div class="drop-overlay-content">
      <DownloadSimpleIcon size={24} weight="regular" />
      <span>Drop files to attach</span>
    </div>
  </div>
{/if}

<style>
  .lazy-modal-loading {
    position: fixed;
    inset: 0;
    z-index: 10024;
    display: grid;
    place-items: center;
    background: color-mix(in oklab, var(--solus-container-bg) 72%, transparent);
    color: var(--solus-text-tertiary);
    font-size: 0.75rem;
  }

  .drop-overlay {
    position: fixed;
    inset: 0;
    z-index: 99;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in oklab, var(--color-zinc-900) 40%, transparent);
    backdrop-filter: blur(0.125rem);
    pointer-events: none;
  }

  .drop-overlay-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.625rem;
    padding: 1.5rem 2.5rem;
    border-radius: 0.75rem;
    border: 0.0938rem dashed var(--color-zinc-600);
    color: var(--color-zinc-400);
    font-size: 0.8125rem;
    font-weight: 500;
  }

  :global(.light) .drop-overlay {
    background: color-mix(in oklab, var(--color-zinc-100) 40%, transparent);
  }

  :global(.light) .drop-overlay-content {
    border-color: var(--color-zinc-400);
    color: var(--color-zinc-500);
  }
</style>
