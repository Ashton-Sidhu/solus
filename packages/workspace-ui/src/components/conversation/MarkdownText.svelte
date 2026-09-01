<script lang="ts" module>
  import { tokenClassName } from "../editor/tokenStyle";
  import { FILE_ICON_VIEWBOX, getFileIconPath, FOLDER_ICON_PATH } from "../editor/fileIcons";
  import { fileChipParts, tokenizeMarkdownText } from "./lib/markdown-text";
</script>

<script lang="ts">
  import { getWorkspaceContext } from "../../contexts";
  import { requestFilePreview } from "../../lib/filePreview";

  let { text = "" }: { text?: string } = $props();

  const session = getWorkspaceContext();

  const segments = $derived(tokenizeMarkdownText(text));

  function handleFileClick(path: string) {
    requestFilePreview({
      path,
      tabId: session.focusedChatTabId ?? session.activeTabId,
    });
  }
</script>

{#each segments as seg, i (i)}
  {#if seg.type === "text"}{seg.value}{:else if seg.type === "file"}{@const isDir = seg.path.endsWith('/')}{@const parts = fileChipParts(seg.path)}<button
      type="button"
      class={tokenClassName("file")}
      title={seg.path}
      onclick={() => handleFileClick(seg.path)}
    ><span class="solus-token__icon"><svg viewBox={FILE_ICON_VIEWBOX} fill="currentColor"><path d={isDir ? FOLDER_ICON_PATH : getFileIconPath(parts.label)} /></svg></span><span
        class="solus-token__copy-only">{parts.prefix}</span>{parts.label}<span
        class="solus-token__copy-only">{parts.suffix}</span></button>{:else}<span class={tokenClassName("slash", true)}>{seg.command}</span>{/if}
{/each}
