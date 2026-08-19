import CodeSpan from "./CodeSpan.svelte";
import MarkdownAlert from "./MarkdownAlert.svelte";
import MarkdownListItem from "./MarkdownListItem.svelte";
import MarkdownRawText from "./MarkdownRawText.svelte";

type MarkdownRenderer =
  | typeof CodeSpan
  | typeof MarkdownAlert
  | typeof MarkdownListItem
  | typeof MarkdownRawText;

export const githubMarkdownRenderers = {
  codespan: CodeSpan,
  alert: MarkdownAlert,
  listitem: MarkdownListItem,
  rawtext: MarkdownRawText,
} satisfies Record<string, MarkdownRenderer>;
