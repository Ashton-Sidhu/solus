import { parser } from "@lezer/markdown";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";

export const HTML_ANCHOR = /<a[\s>]/i;
const HIDDEN_TAGS = new Set(["head", "title", "script", "style", "noscript", "template", "svg"]);

type HtmlNode = DefaultTreeAdapterTypes.ChildNode;
type HtmlElement = DefaultTreeAdapterTypes.Element;

function attribute(element: HtmlElement, name: string): string | undefined {
  return element.attrs.find((entry) => entry.name === name)?.value;
}

function isHidden(element: HtmlElement, style: string, insideReference: boolean): boolean {
  const classes = attribute(element, "class")?.split(/\s+/);
  return (
    HIDDEN_TAGS.has(element.tagName) || attribute(element, "hidden") !== undefined ||
    /(?:^|;)\s*display\s*:\s*none\s*(?:!important\s*)?(?:;|$)/i.test(style) ||
    (insideReference && classes?.includes("solus-token__shown-only") === true)
  );
}

function textIsVisible(style: string, inherited: boolean): boolean {
  const visibility = /(?:^|;)\s*visibility\s*:\s*(visible|initial|hidden|collapse)\s*(?:!important\s*)?(?:;|$)/i.exec(style)?.[1]?.toLowerCase();
  if (!visibility) return inherited;
  return visibility === "visible" || visibility === "initial";
}

function linkDestination(element: HtmlElement): string | undefined {
  const href = attribute(element, "href")?.trim();
  // Embedded controls can change how a destination is parsed.
  // oxlint-disable-next-line eslint/no-control-regex
  if (!href || !/^(?:https?:\/\/|mailto:)/i.test(href) || /[\u0000-\u001f\u007f]/.test(href)) {
    return undefined;
  }
  try {
    // Keep the supplied spelling, including query parameters and percent escapes.
    new URL(href);
    return href;
  } catch {
    return undefined;
  }
}

function markdownLink(label: string, destination: string): string {
  const href = destination
    .replaceAll("&", "&amp;")
    .replaceAll(" ", "%20")
    .replace(/[\\()<>]/g, "\\$&");
  // A link can span line wraps, but cannot span a Markdown paragraph break.
  return label.replace(/\S(?:[^\r\n]*\S)?/g, (line) => {
    const escaped = line.replace(/[&<>\\[\]`*_~]/g, "\\$&");
    return `[${escaped}](${href})`;
  });
}

/** Restore anchors only when HTML and plain text agree. Keep the plain text's spacing. */
export function restoreComposerLinks(
  plain: string,
  html: string,
  isReference?: (source: string) => boolean,
): string | null {
  if (!plain || !HTML_ANCHOR.test(html)) return null;
  const characters = plain.matchAll(/\S/g);
  const replacements: { from: number; to: number; text: string; isLink?: true }[] = [];
  let next = characters.next().value;
  let offset = -1;

  function matchText(text: string): boolean {
    for (const character of text.matchAll(/\S/g)) {
      if (next?.[0] !== character[0]) return false;
      offset = next.index;
      next = characters.next().value;
    }
    return true;
  }

  function match(node: HtmlNode, inCode = false, insideReference = false, visible = true): boolean {
    if ("value" in node) return !visible || matchText(node.value);
    if (!("tagName" in node)) return true;
    const { tagName } = node;
    const style = attribute(node, "style") ?? "";
    if (isHidden(node, style, insideReference)) return true;
    const childTextVisible = textIsVisible(style, visible);

    const source = insideReference ? undefined : attribute(node, "data-solus-reference");
    const isChip = insideReference || source !== undefined;
    const isCode = inCode || tagName === "pre" || tagName === "code";
    const href = !isChip && !isCode && tagName === "a" ? linkDestination(node) : undefined;
    const from = next?.index;
    const previousReplacementCount = replacements.length;
    if (!node.childNodes.every((child) => match(child, isCode, isChip, childTextVisible))) return false;
    if (replacements.length === previousReplacementCount) addReplacement(from, source, href);
    return true;
  }

  function addReplacement(from: number | undefined, source?: string, href?: string) {
    if (from === undefined || offset < from) return;
    const to = offset + 1;
    if (source !== undefined && isReference?.(source)) {
      replacements.push({ from, to, text: source });
    } else if (href) {
      const label = plain.slice(from, to);
      if (label !== href) replacements.push({ from, to, text: markdownLink(label, href), isLink: true });
    }
  }

  if (!parseFragment(html).childNodes.every((node) => match(node)) ||
      next !== undefined || !replacements.some((replacement) => replacement.isLink)) {
    return null;
  }
  let result = "";
  let end = 0;
  for (const { from, to, text, isLink } of replacements) {
    const prefix = plain.slice(end, from);
    // Prevent a preceding backslash or exclamation mark from changing the link syntax.
    result += (isLink ? prefix.replace(/(?<!\\)((?:\\\\)*)([!\\])$/, "$1\\$2") : prefix) + text;
    end = to;
  }
  return result + plain.slice(end);
}

/** Check the selection where a rich paste or drop would insert text. */
export function isComposerCode(markdown: string, from: number, to = from): boolean {
  if (!/[`~\t]| {4}/.test(markdown)) return false;
  let isCode = false;
  parser.parse(markdown).iterate({
    from,
    to,
    enter(node) {
      if (node.name === "InlineCode" || node.name === "CodeBlock" || node.name === "FencedCode") {
        const isClosedFence = node.name === "FencedCode" &&
          node.node.lastChild?.name === "CodeMark" &&
          node.node.firstChild?.from !== node.node.lastChild.from;
        const includesEnd = node.name === "CodeBlock" || (node.name === "FencedCode" && !isClosedFence);
        isCode ||= from < node.to && to > node.from ||
          (from === to && (from > node.from && from < node.to || includesEnd && from === node.to));
      }
      return !isCode;
    },
  });
  return isCode;
}
