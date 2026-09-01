<script lang="ts">
  import {
    PaperclipIcon,
    ArticleIcon,
    GitDiffIcon,
    GearIcon,
    FileTextIcon,
    FolderOpenIcon,
    ArrowsClockwiseIcon,
    GitCommitIcon,
    CheckIcon,
    SpinnerIcon,
    XIcon,
    CaretRightIcon,
  } from "phosphor-svelte";
  import { getWorkspaceContext } from "@renderer/contexts/workspace.context.svelte";
  import { getAgentContext } from "@renderer/contexts/agent.context.svelte";
  import { getSettingsContext } from "@renderer/contexts/settings.context.svelte";
  import { getStatusBarContext } from "@renderer/contexts/status-bar.context.svelte";
  import { buildAgentAvailabilityRows } from "@renderer/lib/agentAvailability";
  import { requestInputFocus } from "@renderer/lib/inputFocus";
  import { REASONING_EFFORT_LABELS } from "../../../src/shared/types";
  import type { ReasoningEffort } from "../../../src/shared/types";
  import { swipeDismiss } from "../lib/swipe-dismiss";
  import WebPushBell from "./WebPushBell.svelte";

  interface Props {
    open: boolean;
    onClose: () => void;
    onAttachFile: () => void;
    onTogglePlans: () => void;
    onToggleDiff: () => void;
    canShowDiffPanel: boolean;
    diffPanelOpen: boolean;
    changedFilesCount: number;
  }
  let {
    open,
    onClose,
    onAttachFile,
    onTogglePlans,
    onToggleDiff,
    canShowDiffPanel,
    diffPanelOpen,
    changedFilesCount,
  }: Props = $props();

  const session = getWorkspaceContext();
  const agent = getAgentContext();
  const settings = getSettingsContext();
  const statusBar = getStatusBarContext();

  const permissionMode = $derived(session.activeSession?.permissionMode ?? 'auto');
  const capabilities = $derived(agent.activeMetadata?.capabilities);
  const supportsPermissions = $derived(capabilities?.permissions !== false);
  const supportsPlan = $derived(capabilities?.planMode !== false);
  const permissionOptions = $derived(
    (['ask', 'auto', 'plan'] as const).filter((id) => id !== 'plan' || supportsPlan)
  );

  const ctx = $derived(statusBar.ctx);
  const reasoningLevels = $derived(ctx.reasoningLevels);
  const currentReasoning = $derived(session.activeSession?.modelConfig.reasoningEffort ?? 'high');

  const activeAgent = $derived(session.activeSession?.provider ?? settings.activeAgent);
  const agentRows = $derived(
    buildAgentAvailabilityRows(agent.agents, agent.metadata).filter((row) => row.enabled)
  );

  function selectPermissionMode(mode: 'ask' | 'auto' | 'plan') {
    session.setPermissionMode(mode);
  }

  function selectReasoning(effort: ReasoningEffort) {
    session.updateModelConfig({ reasoningEffort: effort });
  }

  function selectAgent(agentId: string) {
    session.switchActiveAgent(agentId);
    onClose();
    requestAnimationFrame(() => requestInputFocus());
  }

  const workingDirectory = $derived(ctx.workingDirectory);
  const gitDisabled = $derived(!workingDirectory || workingDirectory === "~");

  const projectName = $derived.by(() => {
    const wd = workingDirectory;
    if (!wd || wd === "~") return "None";
    const parts = wd.replace(/\/+$/, "").split("/");
    return parts[parts.length - 1] || wd;
  });

  let syncing = $state(false);
  let synced = $state(false);
  let commitPushing = $state(false);
  let commitPushed = $state(false);
  let syncTimer: ReturnType<typeof setTimeout> | null = null;
  let commitTimer: ReturnType<typeof setTimeout> | null = null;

  async function handleSync() {
    if (gitDisabled || syncing) return;
    syncing = true;
    synced = false;
    const result = await window.solus.gitSync(session.ctxForDirectory(workingDirectory));
    syncing = false;
    if (result.success) {
      synced = true;
      if (syncTimer) clearTimeout(syncTimer);
      syncTimer = setTimeout(() => {
        synced = false;
        syncTimer = null;
        onClose();
      }, 1000);
    }
  }

  async function handleCommitPush() {
    if (gitDisabled || commitPushing) return;
    commitPushing = true;
    commitPushed = false;
    const result = await window.solus.gitCommitPush(session.ctxForDirectory(workingDirectory));
    commitPushing = false;
    if (result.success) {
      commitPushed = true;
      if (commitTimer) clearTimeout(commitTimer);
      commitTimer = setTimeout(() => {
        commitPushed = false;
        commitTimer = null;
        onClose();
      }, 1000);
    }
  }

  let hasMounted = $state(false);
  let visible = $state(false);
  let sheetEl: HTMLDivElement | undefined = $state();
  let backdropEl: HTMLDivElement | undefined = $state();

  $effect(() => {
    if (open) hasMounted = true;
  });

  $effect(() => {
    if (!hasMounted) return;
    if (open) {
      visible = true;
      requestAnimationFrame(() => {
        if (!sheetEl || !backdropEl) return;
        sheetEl.style.transform = 'translateY(100%)';
        backdropEl.style.opacity = '0';
        requestAnimationFrame(() => {
          if (!sheetEl || !backdropEl) return;
          sheetEl.style.transition = 'transform 0.22s cubic-bezier(0.32, 0.72, 0, 1)';
          backdropEl.style.transition = 'opacity 0.12s ease';
          sheetEl.style.transform = '';
          backdropEl.style.opacity = '';
        });
      });
    } else if (visible) {
      if (sheetEl && backdropEl) {
        sheetEl.style.transition = 'transform 0.18s ease-in';
        backdropEl.style.transition = 'opacity 0.12s ease';
        sheetEl.style.transform = 'translateY(100%)';
        backdropEl.style.opacity = '0';
        const done = () => {
          // Bail if a reopen landed mid-close, else visible sticks false while
          // open stays true and the sheet can't be reopened (see WebSidebarDrawer).
          if (open) return;
          visible = false;
          if (sheetEl) { sheetEl.style.transition = ''; sheetEl.style.transform = ''; }
          if (backdropEl) { backdropEl.style.transition = ''; backdropEl.style.opacity = ''; }
        };
        sheetEl.addEventListener('transitionend', done, { once: true });
        setTimeout(done, 200);
      } else {
        visible = false;
      }
    }
  });

  function handleAction(action: () => void) {
    action();
    onClose();
  }

  // Solus grouped bottom-sheet utilities — frosted surfaces, hairline borders,
  // terracotta accent on press (matches Dropdown / popover language).
  const heroCard =
    "relative flex flex-col items-center justify-center gap-2 py-4 rounded-xl border border-(--solus-container-border) cursor-pointer bg-(--solus-surface-hover) text-(--solus-text-primary) transition-[background-color,transform] duration-[120ms] ease-[cubic-bezier(0.16,1,0.3,1)] active:scale-[0.97] active:bg-(--solus-accent-light) active:border-(--solus-accent-border) disabled:opacity-40 disabled:active:scale-100 disabled:active:bg-(--solus-surface-hover) [-webkit-tap-highlight-color:transparent]";
  const heroIcon = "text-(--solus-accent)";
  const heroLabel = "text-[0.8125rem] font-medium leading-tight text-center text-(--solus-text-primary)";
  const groupCard = "flex flex-col rounded-xl overflow-hidden border border-(--solus-container-border) bg-(--solus-surface-hover)";
  const listRow =
    "flex items-center gap-3.5 w-full min-h-12 px-3.5 py-3 border-0 bg-transparent text-left cursor-pointer transition-colors duration-[120ms] ease-[cubic-bezier(0.16,1,0.3,1)] active:bg-(--solus-accent-light) disabled:opacity-40 disabled:cursor-default disabled:active:bg-transparent [-webkit-tap-highlight-color:transparent]";
  const listIcon = "w-5 flex items-center justify-center shrink-0 text-(--solus-text-secondary)";
  const listLabel = "flex-1 min-w-0 truncate text-[0.9375rem] font-medium text-(--solus-text-primary)";
  const listValue = "shrink-0 max-w-[8rem] truncate text-[0.8125rem] text-(--solus-text-tertiary)";
  const rowDivider = "h-px bg-(--solus-container-border) opacity-60 ml-12";
  const chevronClass = "shrink-0 text-(--solus-text-tertiary)";

  const controlRow = "flex items-center gap-3 py-2 pr-2.5 pl-3.5 rounded-xl border border-(--solus-container-border) bg-(--solus-surface-hover)";
  const controlLabel = "shrink-0 min-w-[4.25rem] text-xs font-medium text-(--solus-text-tertiary)";
  const segmented = "flex-1 flex gap-1 min-w-0";
  const segBtnBase =
    "flex-1 min-w-0 px-1 py-1.5 rounded-lg border truncate text-xs font-medium cursor-pointer transition-[background-color,color,border-color,transform] duration-[120ms] ease-[cubic-bezier(0.16,1,0.3,1)] active:scale-[0.96] [-webkit-tap-highlight-color:transparent]";
  const segBtnActive = "bg-(--solus-accent-light) border-(--solus-accent-border) text-(--solus-text-primary)";
  const segBtnInactive = "bg-transparent border-transparent text-(--solus-text-tertiary)";
</script>

{#if hasMounted}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={backdropEl}
    class="fixed inset-0 z-40 bg-black/35 [-webkit-tap-highlight-color:transparent]"
    class:invisible={!visible}
    class:pointer-events-none={!visible}
    onclick={onClose}
    onkeydown={(e) => e.key === "Escape" && onClose()}
  ></div>

  <!-- Frosted popover surface — matches the side drawer & dropdowns.
       The sheet doesn't scroll; touch-none claims vertical drags for swipe-to-dismiss. -->
  <div
    bind:this={sheetEl}
    class="fixed bottom-0 inset-x-0 z-[41] rounded-t-[1.25rem] border-t border-(--solus-popover-border) bg-(--solus-popover-bg) backdrop-blur-[1.25rem] backdrop-saturate-[1.1] shadow-(--solus-popover-shadow) px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom,0px))] touch-none will-change-transform"
    class:invisible={!visible}
    class:pointer-events-none={!visible}
    use:swipeDismiss={{ axis: "y", sign: 1, onDismiss: onClose, backdrop: () => backdropEl }}
  >
    <div class="w-9 h-1 mx-auto mb-3.5 rounded-[0.125rem] bg-(--solus-text-muted) opacity-30"></div>

    <div class="relative flex items-center justify-center h-9 mb-3">
      <button
        type="button"
        class="absolute left-0 flex items-center justify-center w-9 h-9 rounded-full border border-(--solus-container-border) cursor-pointer bg-(--solus-surface-hover) text-(--solus-text-secondary) transition-colors duration-[120ms] active:bg-(--solus-accent-light) active:text-(--solus-text-primary) [-webkit-tap-highlight-color:transparent]"
        aria-label="Close menu"
        onclick={onClose}
      >
        <XIcon size={18} weight="bold" />
      </button>
      <h2 class="text-[0.9375rem] font-semibold text-(--solus-text-primary)">Add to Chat</h2>
    </div>

    <div class="flex flex-col gap-3">
      <!-- Add-to-chat actions -->
      <div class="grid grid-cols-3 gap-2.5">
        <button class={heroCard} onclick={() => handleAction(onAttachFile)}>
          <span class={heroIcon}><PaperclipIcon size={22} /></span>
          <span class={heroLabel}>Attach file</span>
        </button>

        <button
          class={heroCard}
          onclick={() => handleAction(() => window.dispatchEvent(new CustomEvent("solus:open-directory-picker")))}
        >
          <span class={heroIcon}><FolderOpenIcon size={22} /></span>
          <span class={heroLabel}>Project</span>
        </button>

        <button class={heroCard} onclick={() => handleAction(() => session.toggleFolioGallery())}>
          <span class={heroIcon}><FileTextIcon size={22} /></span>
          <span class={heroLabel}>Folio</span>
        </button>
        <div class={rowDivider}></div>
        <WebPushBell variant="row" />
      </div>

      <!-- Workspace -->
      <div class={groupCard}>
        <button
          class={listRow}
          onclick={() => handleAction(() => window.dispatchEvent(new CustomEvent("solus:open-directory-picker")))}
        >
          <span class={listIcon}><FolderOpenIcon size={18} /></span>
          <span class={listLabel}>Project</span>
          <span class={listValue}>{projectName}</span>
          <CaretRightIcon size={16} class={chevronClass} />
        </button>
        <div class={rowDivider}></div>
        <button class={listRow} disabled={!canShowDiffPanel} onclick={() => handleAction(onToggleDiff)}>
          <span class={listIcon}><GitDiffIcon size={18} /></span>
          <span class={listLabel}>Changes</span>
          {#if changedFilesCount > 0}
            <span class="shrink-0 min-w-[1.125rem] h-[1.125rem] px-1.5 rounded-[0.5625rem] bg-(--solus-accent) text-(--solus-text-on-accent) text-[0.6875rem] font-semibold flex items-center justify-center leading-none tabular-nums">{changedFilesCount}</span>
          {/if}
          <CaretRightIcon size={16} class={chevronClass} />
        </button>
        <div class={rowDivider}></div>
        <button class={listRow} onclick={() => handleAction(onTogglePlans)}>
          <span class={listIcon}><ArticleIcon size={18} /></span>
          <span class={listLabel}>Plans</span>
          <CaretRightIcon size={16} class={chevronClass} />
        </button>
        <div class={rowDivider}></div>
        <button
          class={listRow}
          onclick={() => handleAction(() => {
            if (session.settingsOpen) session.closeSettings();
            else session.showSettings();
          })}
        >
          <span class={listIcon}><GearIcon size={18} /></span>
          <span class={listLabel}>Settings</span>
          <CaretRightIcon size={16} class={chevronClass} />
        </button>
      </div>

      <!-- Source control -->
      {#if !gitDisabled}
        <div class={groupCard}>
          <button class={listRow} onclick={handleSync} disabled={syncing}>
            <span class="{listIcon} {synced ? '!text-(--solus-status-complete)' : ''}">
              {#if syncing}
                <SpinnerIcon size={18} class="animate-spin" />
              {:else if synced}
                <CheckIcon size={18} />
              {:else}
                <ArrowsClockwiseIcon size={18} />
              {/if}
            </span>
            <span class={listLabel}>{synced ? "Synced" : "Sync"}</span>
          </button>
          <div class={rowDivider}></div>
          <button class={listRow} onclick={handleCommitPush} disabled={commitPushing}>
            <span class="{listIcon} {commitPushed ? '!text-(--solus-status-complete)' : ''}">
              {#if commitPushing}
                <SpinnerIcon size={18} class="animate-spin" />
              {:else if commitPushed}
                <CheckIcon size={18} />
              {:else}
                <GitCommitIcon size={18} />
              {/if}
            </span>
            <span class={listLabel}>{commitPushed ? "Pushed" : "Commit & Push"}</span>
          </button>
        </div>
      {/if}
    </div>

    <div class="mt-3 flex flex-col gap-1">
      <span class="block px-1 mb-0.5 text-[0.6875rem] font-semibold tracking-[0.03em] uppercase text-(--solus-text-tertiary)">Session</span>
      <div class={controlRow}>
        <span class={controlLabel}>Reasoning</span>
        <div class={segmented}>
          {#each reasoningLevels as level (level)}
            <button
              type="button"
              class="{segBtnBase} {currentReasoning === level ? segBtnActive : segBtnInactive}"
              onclick={() => selectReasoning(level)}
            >
              {REASONING_EFFORT_LABELS[level]}
            </button>
          {/each}
        </div>
      </div>

      {#if agentRows.length > 0}
        <div class={controlRow}>
          <span class={controlLabel}>Agent</span>
          <div class={segmented}>
            {#each agentRows as a (a.id)}
              <button
                type="button"
                class="{segBtnBase} {activeAgent === a.id ? segBtnActive : segBtnInactive}"
                onclick={() => selectAgent(a.id)}
              >
                {a.label}
              </button>
            {/each}
          </div>
        </div>
      {/if}

      {#if supportsPermissions}
        <div class={controlRow}>
          <span class={controlLabel}>Mode</span>
          <div class={segmented}>
            {#each permissionOptions as mode (mode)}
              <button
                type="button"
                class="{segBtnBase} {permissionMode === mode ? segBtnActive : segBtnInactive}"
                onclick={() => selectPermissionMode(mode)}
              >
                {mode[0].toUpperCase() + mode.slice(1)}
              </button>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}
