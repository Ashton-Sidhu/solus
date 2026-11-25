import type { Root, RootContent } from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

const parser = unified().use(remarkParse).use(remarkGfm);

type MarkdownNode = Root | RootContent;

const CALLOUT_LABELS = new Map([
  ["note", "NOTE"],
  ["tip", "TIP"],
  ["important", "IMPORTANT"],
  ["warning", "WARNING"],
  ["caution", "CAUTION"],
]);

const CALLOUT_MARKER = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\r?\n|$)/i;

/** The edit that turns one quote's callout marker into its label, if it has one. */
function calloutEdit(node: MarkdownNode): { start: number; end: number; content: string } | null {
  if (node.type !== "blockquote") return null;
  const paragraph = node.children[0];
  if (paragraph?.type !== "paragraph") return null;
  const first = paragraph.children[0];
  const start = first?.position?.start.offset;
  if (first?.type !== "text" || start === undefined) return null;
  const marker = CALLOUT_MARKER.exec(first.value);
  const label = CALLOUT_LABELS.get(marker?.[1]?.toLowerCase() ?? "");
  if (!marker || !label) return null;
  const hasBody = first.value.slice(marker[0].length) !== "" || paragraph.children.length > 1;
  // Text on the marker's own line makes it a quote, as on GitHub.
  if (!marker[0].endsWith("\n") && hasBody) return null;
  // The label is its own line: a hard break keeps the body below it.
  return { start, end: start + `[!${marker[1]}]`.length, content: hasBody ? `**${label}**  ` : `**${label}**` };
}

/**
 * Show a callout (`> [!NOTE]`) as a quote led by its kind in capitals. Enriched
 * has no custom block, so the phone cannot draw desktop's band; the kind stays
 * visible above the text, as it is in a narrow desktop column. A marker with
 * text on its own line is a quote, as it is on GitHub.
 */
export function markdownWithCallouts(markdown: string): string {
  if (!markdown.includes("[!")) return markdown;
  const edits: Array<{ start: number; end: number; content: string }> = [];
  const visit = (node: MarkdownNode) => {
    const edit = calloutEdit(node);
    if (edit) edits.push(edit);
    if ("children" in node) node.children.forEach(visit);
  };
  visit(parser.parse(markdown));
  for (const edit of edits.reverse())
    markdown = markdown.slice(0, edit.start) + edit.content + markdown.slice(edit.end);
  return markdown;
}
