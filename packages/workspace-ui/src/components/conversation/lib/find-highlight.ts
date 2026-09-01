import type { ConversationFindMatch } from "./find";

const ALL_HIGHLIGHT = "solus-conversation-find";
const ACTIVE_HIGHLIGHT = "solus-conversation-find-active";

const isSupported =
  globalThis.CSS !== undefined &&
  "highlights" in globalThis.CSS &&
  globalThis.Highlight !== undefined &&
  globalThis.Range !== undefined;

let allHighlight: Highlight | null = null;
let activeHighlight: Highlight | null = null;
let highlightStyle: HTMLStyleElement | null = null;
const highlighters = new Set<ConversationFindHighlighter>();

function ensureRegistered() {
  if (!isSupported || allHighlight) return;
  highlightStyle = document.createElement("style");
  highlightStyle.textContent = `
    ::highlight(${ALL_HIGHLIGHT}) {
      background-color: var(--solus-diff-find-bg);
      color: var(--solus-diff-find-text);
    }
    ::highlight(${ACTIVE_HIGHLIGHT}) {
      background-color: var(--solus-diff-find-active-bg);
      color: var(--solus-diff-find-active-text);
    }
  `;
  document.head.append(highlightStyle);
  allHighlight = new Highlight();
  activeHighlight = new Highlight();
  CSS.highlights.set(ALL_HIGHLIGHT, allHighlight);
  CSS.highlights.set(ACTIVE_HIGHLIGHT, activeHighlight);
}

function releaseIfUnused() {
  if (!isSupported || highlighters.size > 0) return;
  allHighlight?.clear();
  activeHighlight?.clear();
  CSS.highlights.delete(ALL_HIGHLIGHT);
  CSS.highlights.delete(ACTIVE_HIGHLIGHT);
  highlightStyle?.remove();
  highlightStyle = null;
  allHighlight = null;
  activeHighlight = null;
}

function searchableTextNodes(root: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (
        !node.data ||
        parent?.closest("button, [data-solus-ui], [aria-hidden='true']")
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node = walker.nextNode();
  while (node) {
    if (node instanceof Text) nodes.push(node);
    node = walker.nextNode();
  }
  return nodes;
}

function rangesFor(root: HTMLElement, query: string): Range[] {
  const nodes = searchableTextNodes(root);
  const text = nodes.map((node) => node.data).join("");
  const haystack = text.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  if (!needle) return [];

  const starts: number[] = [];
  let start = haystack.indexOf(needle);
  while (start !== -1) {
    starts.push(start);
    start = haystack.indexOf(needle, start + needle.length);
  }

  const ranges: Range[] = [];
  for (const matchStart of starts) {
    const matchEnd = matchStart + needle.length;
    let offset = 0;
    let startNode: Text | null = null;
    let startOffset = 0;
    let endNode: Text | null = null;
    let endOffset = 0;

    for (const node of nodes) {
      const nextOffset = offset + node.data.length;
      if (!startNode && matchStart < nextOffset) {
        startNode = node;
        startOffset = matchStart - offset;
      }
      if (matchEnd <= nextOffset) {
        endNode = node;
        endOffset = matchEnd - offset;
        break;
      }
      offset = nextOffset;
    }

    if (!startNode || !endNode) continue;
    const range = new Range();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    ranges.push(range);
  }
  return ranges;
}

function repaintAll(): Range | null {
  if (!allHighlight || !activeHighlight) return null;
  allHighlight.clear();
  activeHighlight.clear();
  let activeRange: Range | null = null;

  for (const highlighter of highlighters) {
    const range = highlighter.paintInto(allHighlight, activeHighlight);
    if (range) activeRange = range;
  }
  return activeRange;
}

export class ConversationFindHighlighter {
  private root: HTMLElement | null = null;
  private query = "";
  private active: ConversationFindMatch | null = null;

  constructor() {
    ensureRegistered();
    highlighters.add(this);
  }

  update(
    root: HTMLElement | null,
    query: string,
    active: ConversationFindMatch | null,
  ): Range | null {
    this.root = root;
    this.query = query.trim();
    this.active = active;
    return repaintAll();
  }

  paintInto(all: Highlight, current: Highlight): Range | null {
    if (!this.root || !this.query) return null;
    let activeRange: Range | null = null;
    const elements = this.root.querySelectorAll<HTMLElement>(
      "[data-conversation-message-content][data-conversation-message-id]",
    );
    for (const element of elements) {
      const messageId = element.dataset.conversationMessageId;
      const ranges = rangesFor(element, this.query);
      for (let occurrence = 0; occurrence < ranges.length; occurrence++) {
        const range = ranges[occurrence];
        if (
          this.active?.messageId === messageId &&
          this.active.occurrence === occurrence
        ) {
          current.add(range);
          activeRange = range;
        } else {
          all.add(range);
        }
      }
    }
    return activeRange;
  }

  clear() {
    this.root = null;
    this.query = "";
    this.active = null;
    repaintAll();
  }

  destroy() {
    highlighters.delete(this);
    repaintAll();
    releaseIfUnused();
  }
}
