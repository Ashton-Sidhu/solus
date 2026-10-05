<script lang="ts">
  import { onMount } from "svelte";
  import { getWorkspaceContext } from "@solus/workspace-ui/contexts";
  import WebDesktopLayout from "./desktop/WebDesktopLayout.svelte";
  import {
    FILE_PREVIEW_EVENT,
  } from "@solus/workspace-ui/lib/filePreview";

  interface Props {
    onAttachFile: (tabId?: string) => void | Promise<void>;
  }
  let { onAttachFile }: Props = $props();

  const session = getWorkspaceContext();

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
      const detail = e instanceof CustomEvent ? e.detail : undefined;
      if (!detail?.path) return;
      const sourceTabId =
        detail.tabId ?? session.focusedChatTabId ?? session.activeTabId;
      session.openFileInFiles(detail, sourceTabId);
    };
    window.addEventListener(FILE_PREVIEW_EVENT, handler);
    return () => window.removeEventListener(FILE_PREVIEW_EVENT, handler);
  });
</script>

<WebDesktopLayout {onAttachFile} />
