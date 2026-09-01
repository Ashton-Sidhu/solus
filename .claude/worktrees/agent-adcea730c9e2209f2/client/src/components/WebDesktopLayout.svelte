<script lang="ts">
  import { PaperclipIcon, SignOutIcon } from "phosphor-svelte";
  import InputBar from "@renderer/components/input/InputBar.svelte";
  import StatusBarControls from "@renderer/components/layout/StatusBarControls.svelte";
  import WorkspaceBody from "@renderer/components/layout/WorkspaceBody.svelte";
  import { connectionStatusLabel } from "@client-core/connection-display";
  import { getWorkspaceContext } from "@renderer/contexts/workspace.context.svelte";
  import { runtime } from "@renderer/contexts/runtime.svelte";
  import { tooltip } from "@renderer/lib/tooltip";
  import { webState } from "../lib/web-state.svelte";
  import WebPushBell from "./WebPushBell.svelte";

  interface Props {
    onAttachFile: () => void;
  }
  let { onAttachFile }: Props = $props();

  const session = getWorkspaceContext();
  const sess = $derived(session.sessionFor(session.activeTabId));
  const isRunning = $derived(
    sess?.status === "running" || sess?.status === "connecting",
  );
  const isMobile = $derived(runtime.isMobileViewport);
  const connectionLabel = $derived(
    connectionStatusLabel(webState.connectionStatus, {
      attempt: webState.connectionAttempt,
      hasConnected: webState.hasConnected,
    }),
  );
  const showConnectionStatus = $derived(webState.connectionStatus !== "connected");
</script>

<div class="web-frame">
  <div class="workspace" data-solus-ui>
    <WorkspaceBody
      active={!isMobile}
      enableProjectPanel
      enableRunDock
    >
    {#snippet inputRow()}
      <div class="flex items-end w-full" style="padding:0 0.375rem">
        <div
          class="flex items-center flex-shrink-0"
          style="padding-bottom:0.375rem"
        >
          <button
            class="size-9 rounded-full flex items-center justify-center transition-colors hover:bg-(--solus-surface-hover)"
            use:tooltip={"Attach file (⌥⇧A)"}
            onclick={onAttachFile}
            disabled={isRunning}
            class:text-(--solus-text-muted)={isRunning}
            class:text-(--solus-text-tertiary)={!isRunning}
          >
            <PaperclipIcon size={16} />
          </button>
        </div>
        <div
          class="flex-shrink-0 mx-2 bg-(--solus-container-border)"
          style="width:0.0625rem;align-self:stretch;margin-top:0.5rem;margin-bottom:0.5rem;opacity:0.5"
        ></div>
        <div class="flex-1 min-w-0">
          <InputBar mode="editor" />
        </div>
      </div>
    {/snippet}

    {#snippet statusBar()}
      <StatusBarControls mode="editor" dirMaxWidth={240}>
        {#snippet trailingActions()}
          {#if showConnectionStatus}
            <span
              class="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-(--solus-surface-hover) px-2 text-[0.6875rem] tabular-nums text-(--solus-text-tertiary)"
              use:tooltip={connectionLabel}
            >
              <span
                class="h-1.5 w-1.5 rounded-full"
                class:bg-(--solus-accent)={webState.connectionStatus !== "blocked"}
                class:bg-(--solus-status-error)={webState.connectionStatus === "blocked"}
                class:animate-pulse={webState.connectionStatus === "connecting" || webState.connectionStatus === "reconnecting"}
              ></span>
              <span class="max-w-[9rem] truncate">
                {connectionLabel}
              </span>
            </span>
          {/if}
          <WebPushBell />
          <button
            class="ws-logout-btn"
            onclick={() =>
              document.dispatchEvent(new CustomEvent("solus:logout"))}
            use:tooltip={"Switch server"}
            aria-label="Switch server"
          >
            <SignOutIcon size={13} />
          </button>
        {/snippet}
      </StatusBarControls>
    {/snippet}
    </WorkspaceBody>
  </div>
</div>

<style>
  /* Web fills the viewport edge-to-edge so the app reads as a native web
     surface rather than a floating desktop-style card. */
  .web-frame {
    height: 100%;
    width: 100%;
    background: var(--solus-container-bg);
  }

  .workspace {
    display: flex;
    height: 100%;
    width: 100%;
    overflow: hidden;
    background: var(--solus-container-bg);
    contain: layout paint;
  }

  .workspace :global(.conversation-selectable) {
    padding-inline: 1.25rem;
  }

  .workspace :global(.sidebar-header-desktop) {
    padding-bottom: 0.625rem;
  }

  .ws-logout-btn {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.375rem;
    height: 1.375rem;
    border: none;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    padding: 0;
    transition:
      color 0.15s ease,
      background 0.15s ease;
  }

  .ws-logout-btn:hover {
    color: var(--solus-rail-danger-color);
    background: var(--solus-rail-danger-bg);
  }
</style>
