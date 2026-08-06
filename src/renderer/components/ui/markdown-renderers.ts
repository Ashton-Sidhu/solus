import CodeSpan from "./CodeSpan.svelte";
import MarkdownAlert from "./MarkdownAlert.svelte";
import MarkdownListItem from "./MarkdownListItem.svelte";
import MarkdownRawText from "./MarkdownRawText.svelte";

export const githubMarkdownRenderers = {
  codespan: CodeSpan,
  alert: MarkdownAlert,
  listitem: MarkdownListItem,
  rawtext: MarkdownRawText,
};
