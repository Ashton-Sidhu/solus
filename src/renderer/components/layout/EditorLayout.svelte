<script lang="ts">
  import { getWorkspaceContext } from "../../contexts";
  import EditorInputCard from "../input/EditorInputCard.svelte";
  import WorkspaceBody from "./WorkspaceBody.svelte";
  import {
    FILE_PREVIEW_EVENT,
    type FilePreviewRequest,
  } from "../../lib/filePreview";
  import type { DiffScope } from "../../../shared/types";
  interface Props {
    active?: boolean;
    onAttachFile: (tabId?: string) => void | Promise<void>;
    onScreenshot?: ((tabId?: string) => void | Promise<void>) | null;
    onDesignMode?: ((tabId?: string) => void | Promise<void>) | null;
  }
  let { active = true, onAttachFile, onScreenshot, onDesignMode }: Props = $props();

  const session = getWorkspaceContext();
  const router = session.router;

  let prevActiveTabId: string | undefined;
  $effect(() => {
    const current = session.activeTabId;
    if (prevActiveTabId !== undefined && prevActiveTabId !== current) {
      if (router.overlay?.name === "review") router.closeOverlay();
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
      const detail = e instanceof CustomEvent ? e.detail : undefined;
      const targetTabId =
        detail?.tabId ?? session.focusedChatTabId ?? session.activeTabId;
      session.toggleDiff(
        targetTabId,
        detail?.scope ?? { kind: "session" },
        detail?.switchScope ?? false,
      );
    };
    window.addEventListener("solus:toggle-diff-panel", handler);
    return () => window.removeEventListener("solus:toggle-diff-panel", handler);
  });

  $effect(() => {
    const handler = (e: Event) => {
      const detail = e instanceof CustomEvent ? e.detail : undefined;
      if (!detail?.path) return;
      const sourceTabId =
        detail.tabId ?? session.focusedChatTabId ?? session.activeTabId;
      session.openFilePreview(detail, sourceTabId);
    };
    window.addEventListener(FILE_PREVIEW_EVENT, handler);
    return () => window.removeEventListener(FILE_PREVIEW_EVENT, handler);
  });
</script>

<div class="editor-shell flex flex-col h-full w-full overflow-hidden">
  <div class="flex flex-1 min-h-0">
    <WorkspaceBody
      {active}
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
</style>
