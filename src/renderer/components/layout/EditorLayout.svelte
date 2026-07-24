<script lang="ts">
  import { getWorkspaceContext, getWindowContext } from "../../contexts";
  import EditorInputCard from "../input/EditorInputCard.svelte";
  import WorkspaceBody from "./WorkspaceBody.svelte";
  import {
    FILE_PREVIEW_EVENT,
    type FilePreviewRequest,
  } from "../../lib/filePreview";
  import type { DiffScope, GitCheckout } from "../../../shared/types";
  interface Props {
    onAttachFile: (tabId?: string) => void | Promise<void>;
    onScreenshot?: ((tabId?: string) => void | Promise<void>) | null;
    onDesignMode?: ((tabId?: string) => void | Promise<void>) | null;
  }
  let { onAttachFile, onScreenshot, onDesignMode }: Props = $props();

  const session = getWorkspaceContext();
  const windowCtx = getWindowContext();
  const panes = session.panes;

  let prevActiveTabId: string | undefined;
  $effect(() => {
    const current = session.activeTabId;
    if (prevActiveTabId !== undefined && prevActiveTabId !== current) {
      if (panes.secondaryOverlay?.kind === "diff") panes.closeOverlay();
    }
    prevActiveTabId = current;
  });

  $effect(() => {
    const handler = () => {
      session.sessionPickerOpen = !session.sessionPickerOpen;
    };
    window.addEventListener("solus:toggle-session-picker", handler);
    return () =>
      window.removeEventListener("solus:toggle-session-picker", handler);
  });

  $effect(() => {
    const handler = (e: Event) => {
      const detail = (
        e as CustomEvent<{
          tabId?: string;
          cwd?: string;
          checkout?: GitCheckout | null;
          scope?: DiffScope;
          switchScope?: boolean;
        }>
      ).detail;
      const targetTabId =
        detail?.tabId ?? session.focusedChatTabId ?? session.activeTabId;
      const scope = detail?.scope ?? { kind: "session" };
      panes.toggleDiff(
        !!(detail?.cwd ?? session.sessionFor(targetTabId)?.workingDirectory),
        targetTabId,
        scope,
        detail?.switchScope ?? false,
        detail?.cwd,
        detail?.checkout,
      );
    };
    window.addEventListener("solus:toggle-diff-panel", handler);
    return () => window.removeEventListener("solus:toggle-diff-panel", handler);
  });

  $effect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<FilePreviewRequest>).detail;
      if (!detail?.path) return;
      const sourceTabId =
        detail.tabId ?? session.focusedChatTabId ?? session.activeTabId;
      panes.openFilePreview(detail, sourceTabId);
      session.settingsOpen = false;
      session.plansGalleryOpen = false;
    };
    window.addEventListener(FILE_PREVIEW_EVENT, handler);
    return () => window.removeEventListener(FILE_PREVIEW_EVENT, handler);
  });
</script>

<div class="editor-shell flex flex-col h-full w-full overflow-hidden">
  {#if windowCtx.isMac}
    <!-- Native drag strip under the hiddenInset traffic lights; also gives the
         standard double-click-to-zoom behavior without pushing the editor
         chrome below the titlebar area. -->
    <div class="titlebar-drag-zone drag-region" aria-hidden="true"></div>
  {/if}
  <div class="flex flex-1 min-h-0">
    <WorkspaceBody
      active
      enableProjectPanel
      {onAttachFile}
      {onScreenshot}
      {onDesignMode}
    >
      {#snippet inputRow()}
        <EditorInputCard
          class="mx-auto max-w-(--solus-reading-max)"
          onAttachFile={() => onAttachFile()}
          onScreenshot={onScreenshot ? () => onScreenshot() : null}
          onDesignMode={onDesignMode ? () => onDesignMode() : null}
        />
      {/snippet}
    </WorkspaceBody>
  </div>
</div>

<style>
  .editor-shell {
    position: relative;
    background: var(--solus-container-bg);
  }
  .titlebar-drag-zone {
    position: absolute;
    top: 0;
    left: 0;
    z-index: 30;
    width: var(--solus-traffic-light-inset);
    height: var(--solus-titlebar-height);
  }
</style>
