<script lang="ts" module>
  import { tokenClassName } from "../editor/tokenStyle";
  import { fileReferenceText } from "../editor/reference-tokens";
  import FileIcon from "../ui/file-icon/FileIcon.svelte";
  import { fileChipParts, fileMentionTarget, tokenizeMarkdownText } from "./lib/markdown-text";
  import { installChipSelection } from "../../lib/chip-selection";

  installChipSelection();
</script>

<script lang="ts">
  import { getSurfaceContext } from "../../contexts";
  import { fileDrag } from "../../lib/file-drag";
  import { getMarkdownImageContext } from "./lib/markdown-image";
  import { requestFilePreview } from "../../lib/filePreview";

  let { text = "" }: { text?: string } = $props();

  // A file token previews on the person's session; a client with none (the
  // cloud console) shows the token alone.
  const session = getSurfaceContext().workspace;
  const host = getMarkdownImageContext();

  const segments = $derived(tokenizeMarkdownText(text));

  function handleFileClick(mention: string) {
    if (!session) return;
    requestFilePreview({
      ...fileMentionTarget(mention),
      tabId: session.focusedChatTabId ?? session.activeTabId,
    });
  }
</script>

{#each segments as seg, i (i)}
  {#if seg.type === "text"}{seg.value}{:else if seg.type === "file"}{@const parts = fileChipParts(seg.path)}<button
      type="button"
      class={tokenClassName("file")}
      data-solus-reference={fileReferenceText(seg.path)}
      use:fileDrag={() => {
        const serverId = host?.serverId();
        return serverId ? { serverId, path: fileMentionTarget(seg.path).path, ctx: host?.ctx() } : null;
      }}
      title={seg.path}
      onclick={() => handleFileClick(seg.path)}
    ><span class="solus-token__icon"><FileIcon path={seg.path} size={12} /></span><span
        class="solus-token__copy-only">{parts.prefix}</span>{parts.label}<span
        class="solus-token__copy-only">{parts.suffix}</span></button>{:else}<span class={tokenClassName("slash", true)} data-solus-reference={seg.command}>{seg.command}</span>{/if}
{/each}
