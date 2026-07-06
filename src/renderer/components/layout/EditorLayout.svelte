<script lang="ts">
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { getWindowContext } from "../../contexts/window.context.svelte";
  import InputBarRow from "../input/InputBarRow.svelte";
  import StatusBarControls from "./StatusBarControls.svelte";
  import WorkspaceBody from "./WorkspaceBody.svelte";
  import ToastHost from "../ToastHost.svelte";
  import {
    FILE_PREVIEW_EVENT,
    type FilePreviewRequest,
  } from "../../lib/filePreview";
  import type { DiffScope } from "../../../shared/types";
  interface Props {
    onAttachFile: () => void;
    onScreenshot: () => void;
    onDesignMode: () => void;
  }
  let { onAttachFile, onScreenshot, onDesignMode }: Props = $props();

  const session = getWorkspaceContext();
  const windowCtx = getWindowContext();
  const av = session.artifactViewer;
  const sess = $derived(session.sessionFor(session.activeTabId));
  const canShowDiffPanel = $derived(!!sess?.workingDirectory);

  let prevActiveTabId: string | undefined;
  $effect(() => {
    const current = session.activeTabId;
    if (prevActiveTabId !== undefined && prevActiveTabId !== current) {
      if (av.secondary.kind === "diff") av.closeSecondary();
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
        e as CustomEvent<{ scope?: DiffScope; switchScope?: boolean }>
      ).detail;
      const scope = detail?.scope ?? { kind: "session" };
      av.toggleDiff(canShowDiffPanel, scope, detail?.switchScope ?? false);
    };
    window.addEventListener("solus:toggle-diff-panel", handler);
    return () => window.removeEventListener("solus:toggle-diff-panel", handler);
  });

  $effect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<FilePreviewRequest>).detail;
      if (!detail?.path) return;
      if (detail.tabId && detail.tabId !== session.activeTabId) return;
      av.openFilePreview(detail);
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
    <WorkspaceBody active enableProjectPanel enableRunDock>
      {#snippet inputRow()}
        <InputBarRow
          mode="editor"
          {onAttachFile}
          {onScreenshot}
          {onDesignMode}
        />
      {/snippet}
      {#snippet statusBar()}
        <StatusBarControls dirMaxWidth={240} mode="editor" />
      {/snippet}
    </WorkspaceBody>
  </div>

  <ToastHost />
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
