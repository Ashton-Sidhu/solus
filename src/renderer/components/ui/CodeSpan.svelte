<script lang="ts">
  import { tokenClassName } from "../editor/tokenStyle";
  import { FILE_ICON_VIEWBOX, getFileIconPath } from "../editor/fileIcons";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { requestFilePreview } from "../../lib/filePreview";

  interface Props {
    raw?: string;
    text?: string;
  }
  let { raw = "", text }: Props = $props();

  const session = getWorkspaceContext();

  const HTML_ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
  const decodeHtml = (s: string) => s.replace(/&(?:amp|lt|gt|quot|#39);/g, m => HTML_ENTITIES[m]);

  const copyText = $derived(decodeHtml(text ?? raw.replace(/^`+|`+$/g, "")));

  const FILE_PATH_RE = /^(?!@)(?:\.{0,2}\/)?(?:[\w.@~-]+\/)+[\w.@~-]+(?::(\d+))?$/;

  const fileMatch = $derived(copyText.match(FILE_PATH_RE));
  const isFilePath = $derived(!!fileMatch);
  const filePath = $derived(isFilePath ? (fileMatch![1] ? copyText.replace(/:(\d+)$/, '') : copyText) : '');
  const fileLine = $derived(fileMatch?.[1] ? Number(fileMatch[1]) : undefined);

  function basename(path: string): string {
    const idx = path.lastIndexOf("/");
    return idx === -1 ? path : path.slice(idx + 1);
  }

  function parentDir(path: string): string {
    const parts = path.split("/").filter(Boolean);
    if (parts.length < 2) return "";
    return parts[parts.length - 2] + "/";
  }

  function handleFileClick() {
    requestFilePreview({ path: filePath, line: fileLine, tabId: session.activeTabId });
  }

</script>

{#if isFilePath}
  <button
    type="button"
    class={tokenClassName("file")}
    title={copyText}
    onclick={handleFileClick}
  >
    <span class="solus-token__icon">
      <svg viewBox={FILE_ICON_VIEWBOX} fill="currentColor"><path d={getFileIconPath(basename(filePath))} /></svg>
    </span>
    {#if parentDir(filePath)}
      <span class="solus-token__dir">{parentDir(filePath)}</span>
    {/if}
    <span>{basename(filePath)}{fileLine ? `:${fileLine}` : ''}</span>
  </button>
{:else}
  <code>{copyText}</code>
{/if}
