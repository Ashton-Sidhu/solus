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
  const isEditorMode = $derived(windowCtx.viewMode === "editor");
  const sess = $derived(session.sessionFor(session.activeTabId));
  const canShowDiffPanel = $derived(!!sess?.workingDirectory);

  let shellEl: HTMLElement | undefined = $state();
  let isResizingShell = $state(false);
  let shellResizeCorner: "tl" | "tr" | "bl" | "br" = "br";
  let shellResizeStartX = 0;
  let shellResizeStartY = 0;
  let shellResizeStartW = 0;
  let shellResizeStartH = 0;
  const shellHorizontalInset = 16;
  const shellVerticalInset = 48;
  const minShellWidth = 400;
  const minShellHeight = 280;
  const editorShellDefaults = { width: "92%", height: "90%" };
  let customShellWidth = $state<string>("85%");
  let customShellHeight = $state<string>("85%");
  let hasCustomShellSize = $state(false);
  const shellWidth = $derived(
    hasCustomShellSize ? customShellWidth : editorShellDefaults.width,
  );
  const shellHeight = $derived(
    hasCustomShellSize ? customShellHeight : editorShellDefaults.height,
  );

  let isDragging = $state(false);
  let shellOffsetX = $state(0);
  let shellOffsetY = $state(0);
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartOffsetX = 0;
  let dragStartOffsetY = 0;

  function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
  }

  function maxShellWidth() {
    return Math.max(
      minShellWidth,
      windowCtx.workAreaWidth - shellHorizontalInset,
    );
  }

  function maxShellHeight() {
    return Math.max(
      minShellHeight,
      windowCtx.workAreaHeight - shellVerticalInset,
    );
  }

  function clampShellOffset(width: number, height: number) {
    const maxX = Math.max(0, (windowCtx.workAreaWidth - width) / 2);
    const maxY = Math.max(0, (windowCtx.workAreaHeight - height) / 2);
    shellOffsetX = clamp(shellOffsetX, -maxX, maxX);
    shellOffsetY = clamp(shellOffsetY, -maxY, maxY);
  }

  function onDragStart(e: MouseEvent) {
    if (e.button !== 0) return;
    if (shellEl) {
      const rect = shellEl.getBoundingClientRect();
      clampShellOffset(rect.width, rect.height);
    }
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartOffsetX = shellOffsetX;
    dragStartOffsetY = shellOffsetY;
    e.preventDefault();
  }

  function resetPosition() {
    shellOffsetX = 0;
    shellOffsetY = 0;
    hasCustomShellSize = false;
  }

  function onShellResizeStart(corner: typeof shellResizeCorner, e: MouseEvent) {
    if (!shellEl) return;
    isResizingShell = true;
    shellResizeCorner = corner;
    shellResizeStartX = e.clientX;
    shellResizeStartY = e.clientY;
    const rect = shellEl.getBoundingClientRect();
    shellResizeStartW = rect.width;
    shellResizeStartH = rect.height;
    const cursor =
      corner === "tl" || corner === "br" ? "nwse-resize" : "nesw-resize";
    shellEl.style.setProperty("--shell-resize-cursor", cursor);
    e.preventDefault();
  }

  const onResizeTL = (e: MouseEvent) => onShellResizeStart("tl", e);
  const onResizeTR = (e: MouseEvent) => onShellResizeStart("tr", e);
  const onResizeBL = (e: MouseEvent) => onShellResizeStart("bl", e);
  const onResizeBR = (e: MouseEvent) => onShellResizeStart("br", e);

  let shellResizeRaf = 0;

  function handleMouseMove(e: MouseEvent) {
    if (isDragging) {
      const rect = shellEl?.getBoundingClientRect();
      const width = rect?.width ?? windowCtx.workAreaWidth;
      const height = rect?.height ?? windowCtx.workAreaHeight;
      const maxX = Math.max(0, (windowCtx.workAreaWidth - width) / 2);
      const maxY = Math.max(0, (windowCtx.workAreaHeight - height) / 2);
      shellOffsetX = clamp(
        dragStartOffsetX + (e.clientX - dragStartX),
        -maxX,
        maxX,
      );
      shellOffsetY = clamp(
        dragStartOffsetY + (e.clientY - dragStartY),
        -maxY,
        maxY,
      );
      return;
    }
    if (isResizingShell) {
      if (shellResizeRaf) return;
      const mx = e.clientX;
      const my = e.clientY;
      shellResizeRaf = requestAnimationFrame(() => {
        shellResizeRaf = 0;
        const sx =
          shellResizeCorner === "tl" || shellResizeCorner === "bl" ? -1 : 1;
        const sy =
          shellResizeCorner === "tl" || shellResizeCorner === "tr" ? -1 : 1;
        const dw = (mx - shellResizeStartX) * sx * 2;
        const dh = (my - shellResizeStartY) * sy * 2;
        const nextWidth = clamp(
          shellResizeStartW + dw,
          minShellWidth,
          maxShellWidth(),
        );
        const nextHeight = clamp(
          shellResizeStartH + dh,
          minShellHeight,
          maxShellHeight(),
        );
        hasCustomShellSize = true;
        customShellWidth = `${nextWidth}px`;
        customShellHeight = `${nextHeight}px`;
        clampShellOffset(nextWidth, nextHeight);
      });
      return;
    }
  }

  function handleMouseUp() {
    isDragging = false;
    isResizingShell = false;
  }

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
      if (!isEditorMode) return;
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
      if (windowCtx.viewMode !== "editor") void windowCtx.setViewMode("editor");
      session.settingsOpen = false;
      session.plansGalleryOpen = false;
    };
    window.addEventListener(FILE_PREVIEW_EVENT, handler);
    return () => window.removeEventListener(FILE_PREVIEW_EVENT, handler);
  });

  $effect(() => {
    const widthLimit = maxShellWidth();
    const heightLimit = maxShellHeight();
    if (hasCustomShellSize && shellEl) {
      const rect = shellEl.getBoundingClientRect();
      const nextWidth = clamp(rect.width, minShellWidth, widthLimit);
      const nextHeight = clamp(rect.height, minShellHeight, heightLimit);
      if (nextWidth !== rect.width) customShellWidth = `${nextWidth}px`;
      if (nextHeight !== rect.height) customShellHeight = `${nextHeight}px`;
      clampShellOffset(nextWidth, nextHeight);
    }
  });
</script>

<svelte:window onmousemove={handleMouseMove} onmouseup={handleMouseUp} />

<div
  bind:this={shellEl}
  data-solus-ui
  class="editor-shell flex overflow-hidden border border-(--solus-container-border)"
  style="background:var(--solus-container-bg);transform:translate({shellOffsetX}px,{shellOffsetY}px);width:{shellWidth};height:{shellHeight}"
  class:is-shell-resizing={isResizingShell}
  class:is-dragging={isDragging}
>
  <WorkspaceBody
    active={isEditorMode}
    enableProjectPanel={isEditorMode}
    enableRunDock={isEditorMode}
    onStartWindowDrag={onDragStart}
    onResetWindowPosition={resetPosition}
  >
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

  <div
    class="shell-resize-corner corner-tl"
    onmousedown={onResizeTL}
    aria-hidden="true"
  ></div>
  <div
    class="shell-resize-corner corner-tr"
    onmousedown={onResizeTR}
    aria-hidden="true"
  ></div>
  <div
    class="shell-resize-corner corner-bl"
    onmousedown={onResizeBL}
    aria-hidden="true"
  ></div>
  <div
    class="shell-resize-corner corner-br"
    onmousedown={onResizeBR}
    aria-hidden="true"
  ></div>

  <!-- App-wide toast lives inside the shell so it stays within the editor's
       visible bounds (top-right), tracking shell move/resize. -->
  {#if isEditorMode}
    <ToastHost />
  {/if}
</div>

<style>
  .editor-shell {
    position: relative;
    border-radius: 16px;
    isolation: isolate;
    box-shadow:
      0 20px 50px -15px rgba(0, 0, 0, 0.45),
      0 6px 18px -8px rgba(0, 0, 0, 0.25);
    will-change: transform;
  }
  .editor-shell::before {
    content: "";
    position: absolute;
    inset: 0;
    z-index: -1;
    border-radius: inherit;
    background: var(--solus-container-bg);
  }
  .editor-shell.is-dragging,
  .editor-shell.is-dragging * {
    cursor: grabbing !important;
    user-select: none;
  }
  .editor-shell.is-shell-resizing {
    user-select: none;
  }
  .editor-shell.is-shell-resizing,
  .editor-shell.is-shell-resizing * {
    cursor: var(--shell-resize-cursor) !important;
  }
  .shell-resize-corner {
    position: absolute;
    width: 16px;
    height: 16px;
    z-index: 10;
  }
  .corner-tl {
    top: 0;
    left: 0;
    cursor: nwse-resize;
    border-radius: 12px 0 0 0;
  }
  .corner-tr {
    top: 0;
    right: 0;
    cursor: nesw-resize;
    border-radius: 0 12px 0 0;
  }
  .corner-bl {
    bottom: 0;
    left: 0;
    cursor: nesw-resize;
    border-radius: 0 0 0 12px;
  }
  .corner-br {
    bottom: 0;
    right: 0;
    cursor: nwse-resize;
    border-radius: 0 0 12px 0;
  }
</style>
