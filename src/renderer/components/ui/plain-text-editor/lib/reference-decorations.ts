import {
  EditorState,
  StateEffect,
  StateField,
  type Transaction,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import { getFileIconPath, FILE_ICON_VIEWBOX } from "../../../editor/fileIcons";
import {
  extractTrackedReferences,
  parseReferenceTokens,
  serializeReferenceToken,
  type ReferenceParseOptions,
  type ReferenceToken,
  type ReferenceTokenRange,
} from "../../../editor/reference-tokens";
import {
  tokenClassName,
  TOKEN_ICONS,
  type TokenVariant,
} from "../../../editor/tokenStyle";

export interface ReferenceDecorationCallbacks {
  onPlanRefClick?: (planId: string) => void;
  onWorkRefClick?: (workId: string, title?: string) => void;
  onPrRefClick?: (number: number, title?: string) => void;
  onFileRefClick?: (path: string) => void;
}

export interface ReferenceDecorationConfig
  extends ReferenceDecorationCallbacks,
    ReferenceParseOptions {}

interface ReferenceDecorationState {
  decorations: DecorationSet;
  ranges: ReferenceTokenRange[];
  revealedFileStart: number | null;
}

const revealFileEffect = StateEffect.define<number | null>();
const refreshReferencesEffect = StateEffect.define<null>();

function appendSvgSpec(
  parent: Element,
  spec: unknown[],
  inheritedNamespace: string | null = null,
): void {
  const [rawTag, maybeAttrs, ...children] = spec;
  if (typeof rawTag !== "string") return;
  const separator = rawTag.indexOf(" ");
  const namespace =
    separator === -1 ? inheritedNamespace : rawTag.slice(0, separator);
  const tag = separator === -1 ? rawTag : rawTag.slice(separator + 1);
  const element = namespace
    ? document.createElementNS(namespace, tag)
    : document.createElement(tag);
  let childStart = 0;
  if (
    maybeAttrs &&
    typeof maybeAttrs === "object" &&
    !Array.isArray(maybeAttrs)
  ) {
    for (const [name, value] of Object.entries(
      maybeAttrs as Record<string, string>,
    )) {
      element.setAttribute(name, value);
    }
  } else if (maybeAttrs !== undefined) {
    childStart = -1;
  }
  const allChildren = childStart === -1 ? [maybeAttrs, ...children] : children;
  for (const child of allChildren) {
    if (Array.isArray(child)) appendSvgSpec(element, child, namespace);
    else if (typeof child === "string")
      element.appendChild(document.createTextNode(child));
  }
  parent.appendChild(element);
}

function appendTokenIcon(parent: HTMLElement, token: ReferenceToken): void {
  const icon = document.createElement("span");
  icon.className = "solus-token__icon";
  if (token.kind === "file") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", FILE_ICON_VIEWBOX);
    svg.setAttribute("fill", "currentColor");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", getFileIconPath(token.path));
    svg.appendChild(path);
    icon.appendChild(svg);
  } else if (token.kind !== "slash") {
    const iconName =
      token.kind === "plan"
        ? token.status === "accepted"
          ? "planAccepted"
          : token.status === "rejected"
            ? "planRejected"
            : "plan"
        : token.kind;
    appendSvgSpec(icon, TOKEN_ICONS[iconName]);
  }
  if (icon.childNodes.length > 0) parent.appendChild(icon);
}

function tokenVariant(token: ReferenceToken): TokenVariant {
  if (token.kind !== "plan") return token.kind;
  return `plan-${token.status}`;
}

export function referenceTokenClassName(token: ReferenceToken): string {
  const classes = tokenClassName(
    tokenVariant(token),
    token.kind === "slash",
  );
  return token.kind !== "slash"
    ? `${classes} solus-token--link-chip`
    : classes;
}

function tokenLabel(token: ReferenceToken): string {
  switch (token.kind) {
    case "file":
      return token.name;
    case "plan":
    case "work":
    case "session":
      return token.title;
    case "pr":
      return `#${token.number} ${token.title}`;
    case "slash":
      return token.command;
  }
}

function tokenClick(
  token: ReferenceToken,
  callbacks: ReferenceDecorationCallbacks,
): (() => void) | null {
  switch (token.kind) {
    case "file":
      return callbacks.onFileRefClick
        ? () => callbacks.onFileRefClick?.(token.path)
        : null;
    case "plan":
      return callbacks.onPlanRefClick
        ? () => callbacks.onPlanRefClick?.(token.planId)
        : null;
    case "work":
      return callbacks.onWorkRefClick
        ? () => callbacks.onWorkRefClick?.(token.workId, token.title)
        : null;
    case "pr":
      return callbacks.onPrRefClick
        ? () => callbacks.onPrRefClick?.(token.number, token.title)
        : null;
    case "slash":
    case "session":
      return null;
  }
}

class ReferenceWidget extends WidgetType {
  constructor(
    readonly token: ReferenceToken,
    readonly callbacks: ReferenceDecorationCallbacks,
  ) {
    super();
  }

  eq(other: ReferenceWidget): boolean {
    return serializeReferenceToken(this.token) ===
      serializeReferenceToken(other.token);
  }

  toDOM(): HTMLElement {
    const click = tokenClick(this.token, this.callbacks);
    const element = document.createElement(click ? "button" : "span");
    if (element instanceof HTMLButtonElement) element.type = "button";
    element.className = referenceTokenClassName(this.token);
    element.contentEditable = "false";
    element.spellcheck = false;
    element.dataset.referenceKind = this.token.kind;
    appendTokenIcon(element, this.token);
    const label = document.createElement("span");
    label.textContent = tokenLabel(this.token);
    element.appendChild(label);
    if (click) {
      element.tabIndex = -1;
      element.addEventListener("mousedown", (event) => event.preventDefault());
      element.addEventListener("click", click);
    }
    return element;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function buildDecorations(
  state: EditorState,
  ranges: readonly ReferenceTokenRange[],
  config: ReferenceDecorationConfig,
  revealedFileStart: number | null,
): DecorationSet {
  const cursor = state.selection.main.head;
  return Decoration.set(
    ranges.flatMap((range) => {
      if (
        range.token.kind === "file" &&
        cursor >= range.from &&
        cursor <= range.to &&
        (range.from === revealedFileStart || state.selection.main.empty)
      )
        return [];
      return [
        Decoration.replace({
          widget: new ReferenceWidget(range.token, config),
          inclusive: false,
        }).range(range.from, range.to),
      ];
    }),
    true,
  );
}

function changedLineRanges(transaction: Transaction): {
  from: number;
  to: number;
}[] {
  const changed: { from: number; to: number }[] = [];
  transaction.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    const from = transaction.state.doc.lineAt(fromB).from;
    const to = transaction.state.doc.lineAt(toB).to;
    const previous = changed.at(-1);
    if (previous && from <= previous.to + 1) previous.to = Math.max(previous.to, to);
    else changed.push({ from, to });
  });
  return changed;
}

function updateRanges(
  ranges: readonly ReferenceTokenRange[],
  transaction: Transaction,
  config: ReferenceDecorationConfig,
): ReferenceTokenRange[] {
  const changed = changedLineRanges(transaction);
  const mapped = ranges
    .map((range) => ({
      ...range,
      from: transaction.changes.mapPos(range.from, 1),
      to: transaction.changes.mapPos(range.to, -1),
    }))
    .filter(
      (range) =>
        !changed.some(
          (line) => range.from <= line.to && range.to >= line.from,
        ),
    );

  for (const line of changed) {
    const source = transaction.state.doc.sliceString(line.from, line.to);
    mapped.push(
      ...parseReferenceTokens(source, config).map((range) => ({
        ...range,
        from: range.from + line.from,
        to: range.to + line.from,
      })),
    );
  }
  return mapped.sort((left, right) => left.from - right.from);
}

export interface ReferenceDecorations {
  extension: Extension;
  revealFileBeforeCursor(view: EditorView): boolean;
  refresh(view: EditorView): void;
  referenceBeforeCursor(view: EditorView): ReferenceTokenRange | null;
}

export function createReferenceDecorations(
  getConfig: () => ReferenceDecorationConfig,
): ReferenceDecorations {
  const field = StateField.define<ReferenceDecorationState>({
    create(state) {
      const ranges = parseReferenceTokens(state.doc.toString(), getConfig());
      return {
        decorations: buildDecorations(state, ranges, getConfig(), null),
        ranges,
        revealedFileStart: null,
      };
    },
    update(value, transaction) {
      let revealedFileStart = value.revealedFileStart;
      const ranges = transaction.docChanged
        ? updateRanges(value.ranges, transaction, getConfig())
        : value.ranges;
      if (transaction.docChanged && revealedFileStart !== null)
        revealedFileStart = transaction.changes.mapPos(revealedFileStart, 1);
      for (const effect of transaction.effects) {
        if (effect.is(revealFileEffect)) revealedFileStart = effect.value;
      }
      if (
        !transaction.docChanged &&
        !transaction.selection &&
        !transaction.effects.some((effect) =>
          effect.is(refreshReferencesEffect),
        )
      )
        return value;
      return {
        decorations: buildDecorations(
          transaction.state,
          ranges,
          getConfig(),
          revealedFileStart,
        ),
        ranges,
        revealedFileStart,
      };
    },
    provide: (currentField) =>
      EditorView.decorations.from(currentField, (value) => value.decorations),
  });

  function referenceBeforeCursor(view: EditorView): ReferenceTokenRange | null {
    const head = view.state.selection.main.head;
    return (
      parseReferenceTokens(view.state.doc.toString(), getConfig()).find(
        (range) => range.to === head,
      ) ?? null
    );
  }

  return {
    extension: [
      field,
      EditorView.atomicRanges.of((view) =>
        view.state.field(field).decorations,
      ),
    ],
    revealFileBeforeCursor(view) {
      const range = referenceBeforeCursor(view);
      if (range?.token.kind !== "file") return false;
      view.dispatch({
        effects: revealFileEffect.of(range.from),
        selection: { anchor: range.to },
      });
      return true;
    },
    refresh(view) {
      view.dispatch({ effects: refreshReferencesEffect.of(null) });
    },
    referenceBeforeCursor,
  };
}

export function insertReferenceAtCursor(
  view: EditorView,
  token: ReferenceToken,
  triggerPattern: RegExp,
): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const line = view.state.doc.lineAt(selection.head);
  const before = view.state.doc.sliceString(line.from, selection.head);
  const match = before.match(triggerPattern);
  const leadingWhitespace = match
    ? match[0].length - match[0].trimStart().length
    : 0;
  const from =
    match?.index === undefined
      ? selection.head
      : line.from + match.index + leadingWhitespace;
  const source = `${serializeReferenceToken(token)} `;
  view.dispatch({
    changes: { from, to: selection.head, insert: source },
    selection: { anchor: from + source.length },
    scrollIntoView: true,
  });
  return true;
}

export function replaceTriggerAtCursor(
  view: EditorView,
  triggerPattern: RegExp,
  replacement: string,
): { changed: boolean; from: number } {
  const selection = view.state.selection.main;
  if (!selection.empty) return { changed: false, from: selection.head };
  const line = view.state.doc.lineAt(selection.head);
  const before = view.state.doc.sliceString(line.from, selection.head);
  const match = before.match(triggerPattern);
  if (!match || match.index === undefined)
    return { changed: false, from: selection.head };
  const leadingWhitespace = match[0].length - match[0].trimStart().length;
  const from = line.from + match.index + leadingWhitespace;
  view.dispatch({
    changes: { from, to: selection.head, insert: replacement },
    selection: { anchor: from + replacement.length },
  });
  return { changed: true, from };
}

export function deleteReferenceBackward(
  view: EditorView,
  options: ReferenceParseOptions,
): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const range =
    parseReferenceTokens(view.state.doc.toString(), options).find(
      (candidate) => candidate.to === selection.head,
    ) ?? null;
  if (!range || range.token.kind === "file") return false;
  view.dispatch({
    changes: { from: range.from, to: range.to },
    selection: { anchor: range.from },
    scrollIntoView: true,
  });
  return true;
}

export function deleteReferenceForward(
  view: EditorView,
  options: ReferenceParseOptions,
): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const range =
    parseReferenceTokens(view.state.doc.toString(), options).find(
      (candidate) => candidate.from === selection.head,
    ) ?? null;
  if (!range) return false;
  view.dispatch({
    changes: { from: range.from, to: range.to },
    selection: { anchor: range.from },
    scrollIntoView: true,
  });
  return true;
}

export { extractTrackedReferences };
