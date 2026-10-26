<script lang="ts">
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import CodeSpan from "../ui/CodeSpan.svelte";
  import MarkdownAlert from "../ui/MarkdownAlert.svelte";
  import FencedBlock from "./FencedBlock.svelte";
  import MarkdownLink from "./MarkdownLink.svelte";
  import MarkdownList from "./MarkdownList.svelte";
  import MarkdownBlockquote from "./MarkdownBlockquote.svelte";
  import type { AlertType } from "./lib/markdown-extensions";

  /** A GitHub alert (`> [!NOTE]`) in a reply. The body is ordinary reply
   *  markdown, so it renders with the reply's own renderers. */
  let { alertType, text }: { alertType: AlertType; text: string } = $props();

  const markdownRenderers = { code: FencedBlock, codespan: CodeSpan, link: MarkdownLink, list: MarkdownList, blockquote: MarkdownBlockquote };
</script>

<MarkdownAlert {alertType}>
  {#snippet content()}
    <SvelteMarkdown source={text} renderers={markdownRenderers} sanitizeUrl={markdownSanitizeUrl} />
  {/snippet}
</MarkdownAlert>
