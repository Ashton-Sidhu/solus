<script lang="ts">
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import type { IpcContext } from "../../../shared/types";
  import { getWindowContext, getWorkspaceContext } from "../../contexts";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import CodeBlock from "../ui/CodeBlock.svelte";
  import CodeSpan from "../ui/CodeSpan.svelte";
  import MarkdownImage from "../conversation/MarkdownImage.svelte";
  import MarkdownLink from "../conversation/MarkdownLink.svelte";
  import { assistantMarkdownOptions } from "../conversation/lib/assistant-markdown";
  import { setMarkdownImageContext } from "../conversation/lib/markdown-image";
  import { markdownFileDirectory } from "./lib/markdown-file";

  interface Props {
    ctx: IpcContext;
    cwd: string;
    filePath: string;
    displayPath: string;
    contents: string;
  }

  let { ctx, cwd, filePath, displayPath, contents }: Props = $props();

  const workspace = getWorkspaceContext();
  const windowContext = getWindowContext();
  const targetSession = $derived(workspace.sessions[ctx.session.sessionId]);
  const currentPath = $derived(displayPath || filePath);
  const imageDirectory = $derived(markdownFileDirectory(filePath, cwd));

  setMarkdownImageContext({
    cwd: () => imageDirectory,
    serverId: () => targetSession?.run.serverId,
    ctx: () => ctx,
    isWeb: () => windowContext.isWeb,
  });

  const markdownRenderers = {
    code: CodeBlock,
    codespan: CodeSpan,
    image: MarkdownImage,
    link: MarkdownLink,
  };
</script>

<div
  class="h-full min-h-0 overflow-y-auto overscroll-y-contain"
  data-markdown-file-preview
>
  {#if contents.trim()}
    <div
      class="prose-cloud prose-reading prose-transcript mx-auto min-w-0 px-5 pt-5 pb-8 md:px-10 md:pt-6 md:pb-12"
      aria-label={`Rendered Markdown for ${currentPath}`}
    >
      <SvelteMarkdown
        source={contents}
        options={assistantMarkdownOptions}
        renderers={markdownRenderers}
        sanitizeUrl={markdownSanitizeUrl}
      />
    </div>
  {:else}
    <div class="grid h-full min-h-40 place-items-center px-6 text-center text-xs text-(--solus-text-tertiary)">
      This Markdown file is empty.
    </div>
  {/if}
</div>
