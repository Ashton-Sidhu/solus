import CodeSpan from "./CodeSpan.svelte";
import MarkdownAlert from "./MarkdownAlert.svelte";
import MarkdownListItem from "./MarkdownListItem.svelte";
import MarkdownParagraph from "./MarkdownParagraph.svelte";
import MarkdownRawText from "./MarkdownRawText.svelte";

type MarkdownRenderer =
  | typeof CodeSpan
  | typeof MarkdownAlert
  | typeof MarkdownListItem
  | typeof MarkdownParagraph
  | typeof MarkdownRawText;

export const githubMarkdownRenderers = {
  codespan: CodeSpan,
  alert: MarkdownAlert,
  listitem: MarkdownListItem,
  paragraph: MarkdownParagraph,
  rawtext: MarkdownRawText,
} satisfies Record<string, MarkdownRenderer>;
