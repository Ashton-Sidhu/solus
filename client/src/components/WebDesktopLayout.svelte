<script lang="ts">
  import { SignOutIcon } from "phosphor-svelte";
  import EditorInputCard from "@renderer/components/input/EditorInputCard.svelte";
  import WorkspaceBody from "@renderer/components/layout/WorkspaceBody.svelte";
  import { connectionStatusLabel } from "@client-core/connection-display";
  import { runtime } from "@renderer/contexts";
  import { tooltip } from "@renderer/lib/tooltip";
  import { webState } from "../lib/web-state.svelte";
  import WebPushBell from "./WebPushBell.svelte";

  interface Props {
    onAttachFile: (tabId?: string) => void | Promise<void>;
  }
  let { onAttachFile }: Props = $props();

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
      {onAttachFile}
    >
    {#snippet inputRow()}
      <EditorInputCard
        class="mx-auto max-w-(--solus-reading-max)"
        onAttachFile={() => onAttachFile()}
      >
        {#snippet trailingActions()}
          {#if showConnectionStatus}
            <span
              class="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-(--solus-surface-hover) px-2 text-[0.75rem] tabular-nums text-(--solus-text-tertiary)"
              use:tooltip={connectionLabel}
            >
              <span
                class="h-1.5 w-1.5 rounded-full bg-(--solus-accent)"
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
      </EditorInputCard>
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
