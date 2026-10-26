// Adapted from T3 Code apps/mobile/src/lib/markdownDocument.ts (MIT, see UPSTREAM.md).
import type { Root, RootContent } from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

const parser = unified().use(remarkParse).use(remarkGfm);
type MarkdownNode = Root | RootContent;

function decodeCodePoint(codePoint: number, entity: string): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return entity;
  }
  return String.fromCodePoint(codePoint);
}

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|amp|apos|gt|lt|nbsp|quot);/gi,
    (entity, decimal: string | undefined, hexadecimal: string | undefined) => {
      if (decimal) {
        return decodeCodePoint(Number.parseInt(decimal, 10), entity);
      }
      if (hexadecimal) {
        return decodeCodePoint(Number.parseInt(hexadecimal, 16), entity);
      }
      switch (entity.toLowerCase()) {
        case "&amp;":
          return "&";
        case "&apos;":
          return "'";
        case "&gt;":
          return ">";
        case "&lt;":
          return "<";
        case "&nbsp;":
          return "\u00a0";
        case "&quot;":
          return '"';
        default:
          return entity;
      }
    },
  );
}

const HTML_TAG = /<!--[\s\S]*?-->|<\/?[a-z](?:[^>"']|"[^"]*"|'[^']*')*>/gi;

function attribute(tag: string, name: string): string | null {
  const attributes = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of tag.matchAll(attributes)) {
    if (match[1]?.toLowerCase() === name) {
      return decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? "");
    }
  }
  return null;
}

function markdownDestination(url: string): string {
  return `<${url.replace(/&/g, "\\&").replace(/</g, "%3C").replace(/>/g, "%3E").replace(/\|/g, "%7C").replace(/\n/g, "")}>`;
}

const ANCHOR_TAG = /^<\/?a[\s/>]/i;

/** Replacements for the anchor tags still ahead, and how many emitted links are open. */
type AnchorState = { readonly pending: string[]; open: number };

// Code spans keep their text; an odd trailing backslash would escape the closing "]".
function escapeLinkLabel(text: string): string {
  return text
    .replace(/(`+)[\s\S]*?\1|\\*[[\]]/g, (match) =>
      match.startsWith("`") || match.length % 2 === 0
        ? match
        : `${match.slice(0, -1)}\\${match.slice(-1)}`,
    )
    .replace(/\\+$/, (slashes) => (slashes.length % 2 ? `${slashes}\\` : slashes));
}

// An unescaped "!" before the inserted "[" would turn the link into an image.
function bangBefore(text: string, index: number): boolean {
  if (text[index - 1] !== "!") return false;
  let backslashes = 0;
  while (text[index - 2 - backslashes] === "\\") backslashes += 1;
  return backslashes % 2 === 0;
}

/**
 * Pairs `<a>` tags in order. Only a closed anchor with an http(s) or mailto href becomes a
 * Markdown link; any other anchor keeps its text unlinked.
 */
function anchorMarkdown(tags: readonly string[]): AnchorState {
  const replacements = tags.map(() => "");
  const open: Array<{ index: number; href: string | undefined }> = [];
  tags.forEach((tag, index) => {
    if (tag[1] !== "/") {
      const href = attribute(tag, "href")?.trim();
      open.push({ index, href: href && /^(?:https?|mailto):/i.test(href) ? href : undefined });
      return;
    }
    const opening = open.pop();
    if (!opening?.href) return;
    replacements[opening.index] = "[";
    replacements[index] = `](${markdownDestination(opening.href)})`;
  });
  return { pending: replacements, open: 0 };
}

function markdownHtmlTags(content: string): RegExpExecArray[] {
  // An HTML block such as <details> can also contain Markdown fences and code spans.
  const codeRanges: Array<{ start: number; end: number }> = [];
  const tags = [...content.matchAll(HTML_TAG)];
  let tagIndex = 0;
  const delimiters = [...content.matchAll(/`+|~{3,}/g)].filter((delimiter) => {
    while (tags[tagIndex] && tags[tagIndex]!.index + tags[tagIndex]![0].length <= delimiter.index)
      tagIndex += 1;
    const tag = tags[tagIndex];
    return !tag || delimiter.index < tag.index;
  });
  for (let index = 0; index < delimiters.length; index += 1) {
    const opening = delimiters[index]!;
    const lineStart = content.lastIndexOf("\n", opening.index - 1) + 1;
    const fenced =
      opening[0].length >= 3 && /^ {0,3}$/.test(content.slice(lineStart, opening.index));
    if (opening[0][0] === "~" && !fenced) continue;
    let closingIndex = -1;
    for (let candidate = index + 1; candidate < delimiters.length; candidate += 1) {
      const closing = delimiters[candidate]!;
      if (!fenced && closing[0] === opening[0]) {
        closingIndex = candidate;
        break;
      }
      if (!fenced || closing[0][0] !== opening[0][0] || closing[0].length < opening[0].length)
        continue;
      const start = content.lastIndexOf("\n", closing.index - 1) + 1;
      const nextLine = content.indexOf("\n", closing.index);
      const end = nextLine === -1 ? content.length : nextLine;
      if (
        /^ {0,3}$/.test(content.slice(start, closing.index)) &&
        /^\s*$/.test(content.slice(closing.index + closing[0].length, end))
      ) {
        closingIndex = candidate;
        break;
      }
    }
    if (closingIndex === -1) {
      if (fenced) codeRanges.push({ start: opening.index, end: content.length });
      continue;
    }
    const closing = delimiters[closingIndex]!;
    codeRanges.push({ start: opening.index, end: closing.index + closing[0].length });
    index = closingIndex;
  }
  return tags.filter(
    (tag) => !codeRanges.some((range) => tag.index >= range.start && tag.index < range.end),
  );
}

/**
 * Called only for parsed HTML nodes, so Markdown code examples keep their literal tags.
 * `anchors` is shared across sibling inline HTML nodes because each of those carries a single tag.
 */
export function markdownHtmlContent(
  content: string,
  options: { readonly anchors?: AnchorState; readonly inTableCell?: boolean } = {},
): string {
  const tags = markdownHtmlTags(content);
  const anchors =
    options.anchors ??
    anchorMarkdown(tags.map((tag) => tag[0]).filter((tag) => ANCHOR_TAG.test(tag)));
  let result = "";
  let end = 0;
  for (const match of tags) {
    const text = content.slice(end, match.index);
    result += anchors.open > 0 ? escapeLinkLabel(text) : text;
    const replacement = htmlTagMarkdown(match[0], anchors, options);
    if (replacement === "[" && bangBefore(result, result.length))
      result = `${result.slice(0, -1)}\\!`;
    result +=
      anchors.open > 0 && /[\s[]/.test(result.at(-1) ?? "")
        ? replacement.replace(/^ /, "")
        : replacement;
    end = match.index + match[0].length;
  }
  const text = content.slice(end);
  return result + (anchors.open > 0 ? escapeLinkLabel(text) : text);
}

function htmlTagMarkdown(
  tag: string,
  anchors: AnchorState,
  options: { readonly inTableCell?: boolean },
): string {
  if (tag.startsWith("<!--")) return "";
  if (ANCHOR_TAG.test(tag)) {
    const replacement = anchors.pending.shift() ?? "";
    if (replacement === "[") anchors.open += 1;
    else if (replacement) anchors.open -= 1;
    return replacement;
  }
  if (/^<img\b/i.test(tag)) {
    const src = attribute(tag, "src");
    if (!src) return "";
    const alt = (attribute(tag, "alt") ?? "").replace(/[\\[\]&]/g, "\\$&");
    return `![${alt}](${markdownDestination(src)})`;
  }
  // A blank line inside an open link label would end the paragraph before its "]".
  const blockBreak = anchors.open === 0 ? "\n\n" : " ";
  if (/^<summary\b/i.test(tag)) return `${blockBreak}**`;
  if (/^<\/summary\s*>/i.test(tag)) return `**${blockBreak}`;
  // A line break would end the table row, so a cell keeps its content on one line.
  if (/^<br\b/i.test(tag)) return options.inTableCell ? " " : "  \n";
  if (/^<\/?(?:p|div|details)\b/i.test(tag)) return blockBreak;
  return "";
}

/** Convert parsed HTML fragments only, preserving Markdown code and source around them. */
export function markdownWithHtml(markdown: string): string {
  if (!/<(?:!--|\/?[a-z])/i.test(markdown)) return markdown;
  const edits: Array<{ start: number; end: number; content: string }> = [];
  const visit = (node: MarkdownNode, inTableCell: boolean, inLink: boolean) => {
    if (!("children" in node)) return;
    inTableCell ||= node.type === "tableCell";
    const children: readonly MarkdownNode[] = node.children;
    // Inline HTML arrives one tag per node, so anchors pair across phrasing siblings.
    const anchors =
      node.type === "root" || node.type === "blockquote" || node.type === "listItem"
        ? undefined
        : anchorMarkdown(
            children.flatMap((child) =>
              child.type === "html"
                ? markdownHtmlTags(child.value)
                    .map((tag) => tag[0])
                    .filter((tag) => ANCHOR_TAG.test(tag))
                : [],
            ),
          );
    for (const child of children) {
      const start = child.position?.start.offset;
      const end = child.position?.end.offset;
      const linkLabel = inLink || (anchors?.open ?? 0) > 0;
      if (child.type === "text") {
        if (linkLabel && start !== undefined && end !== undefined) {
          const content = escapeLinkLabel(markdown.slice(start, end));
          if (content !== markdown.slice(start, end)) edits.push({ start, end, content });
        }
        continue;
      }
      if (child.type !== "html") {
        visit(child, inTableCell, linkLabel);
        continue;
      }
      const content = markdownHtmlContent(child.value, { anchors, inTableCell });
      if (start === undefined || end === undefined) continue;
      // Text before an outermost link is never edited, so this edit cannot overlap another.
      if (content.startsWith("[") && !linkLabel && bangBefore(markdown, start))
        edits.push({ start: start - 1, end: start, content: "\\!" });
      edits.push({ start, end, content });
    }
  };
  visit(parser.parse(markdown), false, false);
  for (const edit of edits.reverse())
    markdown = markdown.slice(0, edit.start) + edit.content + markdown.slice(edit.end);
  return markdown;
}

/**
 * Give an image on a line of its own its own paragraph. Markdown joins a caption
 * and the image on the next line into one paragraph, and Enriched draws an image
 * inside a paragraph as a 20pt inline icon. Desktop's browser draws the same
 * image at full size, so the phone matches it. An image inside a sentence, list,
 * or quote keeps its place.
 */
export function markdownWithBlockImages(markdown: string): string {
  if (!markdown.includes("![")) return markdown;
  const edits: Array<{ start: number; end: number; content: string }> = [];
  for (const paragraph of parser.parse(markdown).children) {
    if (paragraph.type !== "paragraph") continue;
    const start = paragraph.position?.start.offset;
    const end = paragraph.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const firstLine = paragraph.position!.start.line;
    const imageLines = new Set<number>();
    for (const child of paragraph.children) {
      const imageStart = child.position?.start.offset;
      const imageEnd = child.position?.end.offset;
      if (child.type !== "image" || imageStart === undefined || imageEnd === undefined) continue;
      if (child.position!.start.line !== child.position!.end.line) continue;
      const lineStart = markdown.lastIndexOf("\n", imageStart - 1) + 1;
      const lineEnd = markdown.indexOf("\n", imageEnd);
      const before = markdown.slice(lineStart, imageStart);
      const after = markdown.slice(imageEnd, lineEnd === -1 ? markdown.length : lineEnd);
      if (/^\s*$/.test(before) && /^\s*\\?\s*$/.test(after))
        imageLines.add(child.position!.start.line - firstLine);
    }
    const lines = markdown.slice(start, end).split("\n");
    if (imageLines.size === 0 || imageLines.size === lines.length) continue;
    const blocks: string[][] = [];
    lines.forEach((line, index) => {
      if (imageLines.has(index)) blocks.push([line.trim().replace(/\s*\\$/, "")]);
      else if (index === 0 || imageLines.has(index - 1)) blocks.push([line]);
      else blocks.at(-1)!.push(line);
    });
    // A hard break that ended a caption has nothing left to break.
    const content = blocks
      .map((block) => block.join("\n").replace(/(?: {2,}|\\)$/, ""))
      .join("\n\n");
    edits.push({ start, end, content });
  }
  for (const edit of edits.reverse())
    markdown = markdown.slice(0, edit.start) + edit.content + markdown.slice(edit.end);
  return markdown;
}
