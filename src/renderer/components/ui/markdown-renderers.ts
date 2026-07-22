import CodeSpan from "./CodeSpan.svelte";
import MarkdownAlert from "./MarkdownAlert.svelte";
import MarkdownListItem from "./MarkdownListItem.svelte";

export const githubMarkdownRenderers = {
  codespan: CodeSpan,
  alert: MarkdownAlert,
  listitem: MarkdownListItem,
};
