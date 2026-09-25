<script lang="ts">
  import { tokenClassName } from "../editor/tokenStyle";
  import { FILE_ICON_VIEWBOX, getFileIconPath } from "../editor/fileIcons";
  import { getSurfaceContext } from "../../contexts";
  import { requestFilePreview } from "../../lib/filePreview";
  import { basename, leadingDirs, parentDir } from "./lib/code-span-path";
  import { boldTextInCodeSpan } from "../../lib/markdownBoldCode";

  interface Props {
    raw?: string;
    text?: string;
  }
  let { raw = "", text }: Props = $props();

  // A file path opens a preview on the person's session; a client with no
  // session (the cloud console) shows the path as code.
  const workspace = getSurfaceContext().workspace;

  // No entity decoding here: marked ≥13 hands codespan token text through
  // literally, so `&amp;` in a code span is content the author typed and
  // CommonMark requires it to display as-is. (An older marked escaped codespan
  // tokens, which is what the decode this replaced was compensating for.)
  const copyText = $derived(text ?? raw.replace(/^`+|`+$/g, ""));
  const boldText = $derived(boldTextInCodeSpan(copyText));

  const FILE_PATH_RE = /^(?!@)(?:\.{0,2}\/)?(?:[\w.@~-]+\/)+[\w.@~-]+(?::(\d+))?$/;
  // A bare abbreviated-or-full hex hash — an address rather than a literal you
  // would retype. Only surfaces that opt in style it (see .prose-pr-description).
  const SHA_RE = /^[0-9a-f]{7,40}$/i;

  const fileMatch = $derived(copyText.match(FILE_PATH_RE));
  const isSha = $derived(SHA_RE.test(copyText));
  const isFilePath = $derived(!!fileMatch && !!workspace);
  const filePath = $derived(isFilePath ? (fileMatch![1] ? copyText.replace(/:(\d+)$/, '') : copyText) : '');
  const fileLine = $derived(fileMatch?.[1] ? Number(fileMatch[1]) : undefined);

  function handleFileClick() {
    requestFilePreview({
      path: filePath,
      line: fileLine,
      tabId: workspace!.focusedChatTabId ?? workspace!.activeTabId,
    });
  }

</script>

{#if isFilePath}
  <button
    type="button"
    class={tokenClassName("file")}
    title={copyText}
    onclick={handleFileClick}
  ><span class="solus-token__icon"><svg viewBox={FILE_ICON_VIEWBOX} fill="currentColor"><path d={getFileIconPath(basename(filePath))} /></svg></span><span
      class="solus-token__copy-only">{leadingDirs(filePath)}</span>{#if parentDir(filePath)}<span
      class="solus-token__dir">{parentDir(filePath)}</span>{/if}{basename(filePath)}{fileLine ? `:${fileLine}` : ''}</button>
{:else if boldText !== null}
  <strong>{boldText}</strong>
{:else}
  <code class:markdown-sha={isSha}>{copyText}</code>
{/if}
