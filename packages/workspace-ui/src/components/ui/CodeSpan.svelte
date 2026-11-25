<script lang="ts">
  import { tokenClassName } from "../editor/tokenStyle";
  import FileIcon from "./file-icon/FileIcon.svelte";
  import { getSurfaceContext, hasSurfaceContext } from "../../contexts";
  import { fileDrag } from "../../lib/file-drag";
  import { getMarkdownImageContext } from "../conversation/lib/markdown-image";
  import { requestFilePreview } from "../../lib/filePreview";
  import { COMMIT_HASH_RE, codeSpanFileTarget, leadingDirs, parentDir } from "./lib/code-span-path";
  import { boldTextInCodeSpan } from "@solus/document-model/markdown";
  import { hostPathBaseName } from "@solus/contracts/host-path";

  interface Props {
    raw?: string;
    text?: string;
  }
  let { raw = "", text }: Props = $props();

  // A file path opens a preview on the person's session; a client with no
  // session (the cloud console, which sets no surface context) shows the path as code.
  const host = getMarkdownImageContext();
  const workspace = hasSurfaceContext() ? getSurfaceContext().workspace : null;

  // No entity decoding here: marked ≥13 hands codespan token text through
  // literally, so `&amp;` in a code span is content the author typed and
  // CommonMark requires it to display as-is. (An older marked escaped codespan
  // tokens, which is what the decode this replaced was compensating for.)
  const copyText = $derived(text ?? raw.replace(/^`+|`+$/g, ""));
  const boldText = $derived(boldTextInCodeSpan(copyText));

  const isSha = $derived(COMMIT_HASH_RE.test(copyText));
  const fileTarget = $derived(workspace ? codeSpanFileTarget(copyText) : null);
  const filePath = $derived(fileTarget?.path ?? "");
  const fileLine = $derived(fileTarget?.line);

  function handleFileClick() {
    requestFilePreview({
      path: filePath,
      line: fileLine,
      tabId: workspace!.focusedChatTabId ?? workspace!.activeTabId,
    });
  }

</script>

{#if fileTarget}
  <button
    type="button"
    class={tokenClassName("file")}
    use:fileDrag={() => {
      const serverId = host?.serverId();
      return serverId ? { serverId, path: filePath, ctx: host?.ctx() } : null;
    }}
    title={copyText}
    onclick={handleFileClick}
  ><span class="solus-token__icon"><FileIcon path={filePath} size={12} /></span><span
      class="solus-token__copy-only">{leadingDirs(filePath)}</span>{#if parentDir(filePath)}<span
      class="solus-token__dir">{parentDir(filePath)}</span>{/if}{hostPathBaseName(filePath)}{fileLine ? `:${fileLine}` : ''}</button>
{:else if boldText !== null}
  <strong>{boldText}</strong>
{:else}
  <code class:markdown-sha={isSha}>{copyText}</code>
{/if}
