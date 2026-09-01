<script lang="ts">
  import { PlugsIcon, SignOutIcon } from "phosphor-svelte";
  import EditorInputCard from "@renderer/components/input/EditorInputCard.svelte";
  import WorkspaceBody from "@renderer/components/layout/WorkspaceBody.svelte";
  import { connectionStatusLabel } from "@client-core/connection-display";
  import { serverConnections } from "@client-core/server-connections";
  import { runtime } from "@renderer/contexts";
  import * as TooltipUI from "@renderer/components/ui/tooltip";
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
  // No host at all is a different problem from a host that dropped: there is
  // nothing to reconnect to, so the chrome offers the fix instead of a status.
  // A host only ever arrives by page reload, so this is settled at mount.
  const noHost = !serverConnections.connectionFor();
  const showConnectionStatus = $derived(webState.connectionStatus !== "connected");
</script>

<div class="web-frame">
  <div class="workspace" data-solus-ui>
    <WorkspaceBody
      active={!isMobile}
      enableProjectPanel
      {onAttachFile}
    >
    {#snippet inputRow()}
      <EditorInputCard
        class="mx-auto max-w-(--solus-reading-max)"
        onAttachFile={() => onAttachFile()}
      >
        {#snippet trailingActions()}
          {#if noHost}
            <TooltipUI.Root>
              <TooltipUI.Trigger>
                {#snippet child({ props: tooltipProps })}
                  <button
                    {...tooltipProps}
                    class="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-(--solus-surface-hover) px-2 text-xs text-(--solus-text-tertiary) transition-[background-color,color] hover:bg-(--solus-accent-light) hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-input-focus-ring)"
                    onclick={() => webState.openServerSetup()}
                  >
                    <PlugsIcon size={14} class="shrink-0" />
                    <span>No host</span>
                  </button>
                {/snippet}
              </TooltipUI.Trigger>
              <TooltipUI.Content value="Connect a host to start working" />
            </TooltipUI.Root>
          {:else if showConnectionStatus}
            <TooltipUI.Root>
              <TooltipUI.Trigger>
                {#snippet child({ props: tooltipProps })}
                  <span {...tooltipProps}
              class="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-(--solus-surface-hover) px-2 text-xs tabular-nums text-(--solus-text-tertiary)"
            >
              <span
                class="h-1.5 w-1.5 rounded-full bg-(--solus-accent)"
                class:animate-pulse={webState.connectionStatus === "connecting" || webState.connectionStatus === "reconnecting"}
              ></span>
              <span class="max-w-[9rem] truncate">
                {connectionLabel}
              </span>
            </span>
                {/snippet}
              </TooltipUI.Trigger>
              <TooltipUI.Content value={connectionLabel} />
            </TooltipUI.Root>
          {/if}
          <WebPushBell />
          <TooltipUI.Root>
            <TooltipUI.Trigger>
              {#snippet child({ props: tooltipProps })}
                <button {...tooltipProps}
            class="ws-logout-btn"
            onclick={() =>
              document.dispatchEvent(new CustomEvent("solus:logout"))}
            aria-label="Switch server"
          >
            <SignOutIcon size={14} />
          </button>
              {/snippet}
            </TooltipUI.Trigger>
            <TooltipUI.Content value={"Switch server"} />
          </TooltipUI.Root>
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
