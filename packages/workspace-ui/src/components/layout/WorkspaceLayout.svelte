<script lang="ts">
  import { getWorkspaceContext } from "../../contexts";
  import EditorInputCard from "../input/EditorInputCard.svelte";
  import WorkspaceBody from "./WorkspaceBody.svelte";
  import {
    FILE_PREVIEW_EVENT,
    filePreviewMediaKind,
    type FilePreviewRequest,
  } from "../../lib/filePreview";
  import { runHost, workingPlace } from "../../contexts/workspace/run-location";
  import MediaFileModal from "../files/MediaFileModal.svelte";
  interface Props {
    onAttachFile: (tabId?: string) => void | Promise<void>;
    onScreenshot?: ((tabId?: string) => void | Promise<void>) | null;
  }
  let { onAttachFile, onScreenshot }: Props = $props();

  const session = getWorkspaceContext();
  let mediaPreview = $state<FilePreviewRequest | null>(null);

  $effect(() => {
    const handler = () => {
      session.ui.unifiedPickerOpen = !session.ui.unifiedPickerOpen;
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
      const detail: FilePreviewRequest | undefined = e instanceof CustomEvent ? e.detail : undefined;
      if (!detail?.path) return;
      const sourceTabId =
        detail.tabId ?? session.focusedChatTabId ?? session.activeTabId;
      const mediaKind = detail.mediaKind ?? filePreviewMediaKind(detail.path);
      if (mediaKind) {
        const run = session.sessionFor(sourceTabId)?.run;
        mediaPreview = {
          ...detail,
          mediaKind,
          source: {
            serverId: detail.source?.serverId ?? runHost(run),
            cwd: detail.source?.cwd ?? workingPlace(run)?.path,
            ctx: detail.source?.ctx ?? session.ctxFor(sourceTabId),
          },
        };
        return;
      }
      session.openFileInFiles(detail, sourceTabId);
    };
    window.addEventListener(FILE_PREVIEW_EVENT, handler);
    return () => window.removeEventListener(FILE_PREVIEW_EVENT, handler);
  });
</script>

<div class="workspace-layout flex flex-col h-full w-full overflow-hidden">
  <div class="flex flex-1 min-h-0">
    <WorkspaceBody
      active
      enableProjectPanel
      {onAttachFile}
      {onScreenshot}
    >
      {#snippet inputRow()}
        <EditorInputCard
          active
          class="mx-auto max-w-(--solus-reading-max)"
          onAttachFile={() => onAttachFile()}
          onScreenshot={onScreenshot ? () => onScreenshot() : null}
        />
      {/snippet}
    </WorkspaceBody>
  </div>
</div>

{#if mediaPreview}
  <MediaFileModal request={mediaPreview} onclose={() => (mediaPreview = null)} />
{/if}

<style>
  .workspace-layout {
    position: relative;
    background: var(--solus-container-bg);
  }
</style>
