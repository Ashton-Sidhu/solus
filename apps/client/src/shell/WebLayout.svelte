<script lang="ts">
  import { onMount } from "svelte";
  import { getWorkspaceContext } from "@solus/workspace-ui/contexts";
  import WebDesktopLayout from "./desktop/WebDesktopLayout.svelte";
  import {
    FILE_PREVIEW_EVENT,
    filePreviewMediaKind,
    type FilePreviewRequest,
  } from "@solus/workspace-ui/lib/filePreview";
  import { runHost, workingPlace } from "@solus/workspace-ui/contexts/workspace/run-location";
  import MediaFileModal from "@solus/workspace-ui/components/files/MediaFileModal.svelte";

  interface Props {
    onAttachFile: (tabId?: string) => void | Promise<void>;
  }
  let { onAttachFile }: Props = $props();

  const session = getWorkspaceContext();
  let mediaPreview = $state<FilePreviewRequest | null>(null);

  onMount(() => {
    const handler = () => {
      session.ui.unifiedPickerOpen = !session.ui.unifiedPickerOpen;
    };
    window.addEventListener("solus:toggle-session-picker", handler);
    return () => window.removeEventListener("solus:toggle-session-picker", handler);
  });

  onMount(() => {
    const handler = (e: Event) => {
      const detail = e instanceof CustomEvent ? e.detail : undefined;
      const sourceTabId =
        detail?.tabId ?? session.focusedChatTabId ?? session.activeTabId;
      session.toggleDiff(sourceTabId, detail?.scope ?? { kind: "session" });
    };
    window.addEventListener("solus:toggle-diff-panel", handler);
    return () => window.removeEventListener("solus:toggle-diff-panel", handler);
  });

  onMount(() => {
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

<WebDesktopLayout {onAttachFile} />

{#if mediaPreview}
  <MediaFileModal request={mediaPreview} onclose={() => (mediaPreview = null)} />
{/if}
