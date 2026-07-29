<script lang="ts">
  import { getWorkspaceContext } from "../../contexts";
  import EditorInputCard from "../input/EditorInputCard.svelte";
  import ConversationView from "./ConversationView.svelte";

  interface Props {
    tabId: string;
    onAttachFile?: (tabId?: string) => void | Promise<void>;
    onScreenshot?: ((tabId?: string) => void | Promise<void>) | null;
    onDesignMode?: ((tabId?: string) => void | Promise<void>) | null;
  }
  let {
    tabId,
    onAttachFile,
    onScreenshot,
    onDesignMode,
  }: Props = $props();

  const session = getWorkspaceContext();
  const panes = session.panes;

  const splitSession = $derived(session.sessionFor(tabId));

  async function attachFile() {
    if (onAttachFile) {
      await onAttachFile(tabId);
      return;
    }
    const files = await window.solus.attachFiles();
    if (!files || files.length === 0) return;
    session.addAttachments(files, tabId);
  }

  function toggleDiff() {
    panes.toggleDiff(!!splitSession?.workingDirectory, tabId);
  }

</script>

<div
  class="flex h-full min-h-0 min-w-0 flex-col border-l border-(--solus-container-border) bg-(--solus-container-bg)"
  onfocusin={() => panes.focusPane("secondary")}
>
  <div class="flex min-h-0 flex-1 flex-col">
    <ConversationView {tabId} onDiffToggle={toggleDiff} forceVisible />
  </div>

  <div class="shrink-0 px-4 pt-2.5 pb-3">
    <EditorInputCard
      class="mx-auto max-w-(--solus-reading-max)"
      {tabId}
      onAttachFile={attachFile}
      onScreenshot={onScreenshot ? () => onScreenshot(tabId) : null}
      onDesignMode={onDesignMode ? () => onDesignMode(tabId) : null}
    />
  </div>
</div>
