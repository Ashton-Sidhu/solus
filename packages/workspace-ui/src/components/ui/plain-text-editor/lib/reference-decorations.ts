import {
  EditorSelection,
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
import { resolveFileIcon } from "@solus/client-core/file-icons";
import {
  extractTrackedReferences,
  parseReferenceTokens,
  referenceCopyText,
  referenceHref,
  serializeReferenceToken,
  type ReferenceParseOptions,
  type ReferenceToken,
  type ReferenceTokenRange,
} from "../../../editor/reference-tokens";
import {
  tokenClassName,
  TOKEN_ICONS,
  type SvgSpec,
  type TokenVariant,
} from "../../../editor/tokenStyle";
import { splitFileLine } from "../../../../lib/file-href";
import { referenceClipboard, restoreReferences } from "../../../editor/reference-clipboard";

export interface ReferenceDecorationCallbacks {
  onPlanRefClick?: (planId: string) => void;
  onWorkRefClick?: (workId: string, title?: string) => void;
  onPrRefClick?: (number: number, title?: string) => void;
  /** A pasted file link keeps its line (`@src/foo.ts:12`), passed apart. */
  onFileRefClick?: (path: string, line?: number) => void;
  /** A session, task, automation, or host chip: the link it opens, as the
   *  same chip does in a message. */
  onLinkRefClick?: (href: string, title: string) => void;
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
  spec: SvgSpec,
  inheritedNamespace: string | null = null,
): void {
  const [rawTag, attrs, ...children] = spec;
  const separator = rawTag.indexOf(" ");
  const namespace =
    separator === -1 ? inheritedNamespace : rawTag.slice(0, separator);
  const tag = separator === -1 ? rawTag : rawTag.slice(separator + 1);
  const element = namespace
    ? document.createElementNS(namespace, tag)
    : document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    element.setAttribute(name, value);
  }
  for (const child of children) {
    if (Array.isArray(child)) appendSvgSpec(element, child, namespace);
    else element.appendChild(document.createTextNode(child));
  }
  parent.appendChild(element);
}

function appendTokenIcon(parent: HTMLElement, token: ReferenceToken): void {
  const icon = document.createElement("span");
  icon.className = "solus-token__icon";
  if (token.kind === "file") {
    icon.innerHTML = resolveFileIcon(token.path).svg;
  } else if (token.kind !== "slash") {
    const iconName =
      token.kind === "login" ? "person" :
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
  // A login is text, never a chip; if one is ever drawn, it reads as a person.
  if (token.kind === "login") return "person";
  if (token.kind !== "plan") return token.kind;
  return `plan-${token.status}`;
}

export function referenceTokenClassName(token: ReferenceToken): string {
  return tokenClassName(tokenVariant(token), token.kind === "slash");
}

function tokenLabel(token: ReferenceToken): string {
  switch (token.kind) {
    case "file":
      return token.name;
    case "plan":
    case "work":
    case "session":
    case "task":
    case "automation":
      return token.title;
    case "pr":
      return `#${token.number} ${token.title}`;
    case "slash":
      return token.command;
    case "person":
      return `@${token.name}`;
    case "host":
      return token.label;
    case "login":
      return `@${token.login}`;
  }
}

function tokenClick(
  token: ReferenceToken,
  callbacks: ReferenceDecorationCallbacks,
): (() => void) | null {
  switch (token.kind) {
    case "file":
      return callbacks.onFileRefClick
        ? () => {
            const target = splitFileLine(token.path);
            callbacks.onFileRefClick?.(target.path, target.line);
          }
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
    case "session":
    case "task":
    case "automation":
    case "host": {
      const href = referenceHref(token);
      return callbacks.onLinkRefClick && href
        ? () => callbacks.onLinkRefClick?.(href, referenceCopyText(token))
        : null;
    }
    case "slash":
    case "person":
    case "login":
      return null;
  }
}

/** How far a press on a chip moves before it is a drag rather than a click. */
const CHIP_DRAG_DISTANCE = 4;

/**
 * A chip selects like a word of the text. CodeMirror ignores events on the
 * widget, so a drag or a double-click that began on a chip selected nothing.
 * A double-click selects the chip; a drag selects from the chip's far edge to
 * the pointer, so the chip is always in it; a press that does not move is a
 * click, and a chip that opens nothing puts the caret at its nearer edge.
 */
function selectFromChip(
  view: EditorView,
  element: HTMLElement,
  length: number,
  press: MouseEvent,
  opensOnClick: boolean,
): void {
  const from = view.posAtDOM(element);
  const to = from + length;
  if (press.detail === 2) {
    view.dispatch({ selection: { anchor: from, head: to }, userEvent: "select.pointer" });
    view.focus();
    return;
  }
  let isDragging = false;
  const move = (event: MouseEvent) => {
    if (!isDragging && Math.hypot(event.clientX - press.clientX, event.clientY - press.clientY) < CHIP_DRAG_DISTANCE) return;
    isDragging = true;
    const head = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
    const isBackward = head <= from;
    view.dispatch({
      selection: { anchor: isBackward ? to : from, head: isBackward || head >= to ? head : to },
      userEvent: "select.pointer",
    });
  };
  const release = (event: MouseEvent) => {
    document.removeEventListener("mousemove", move);
    if (isDragging || opensOnClick) return;
    const box = element.getBoundingClientRect();
    view.dispatch({ selection: { anchor: event.clientX < box.left + box.width / 2 ? from : to } });
  };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", release, { once: true });
  view.focus();
}

class ReferenceWidget extends WidgetType {
  constructor(
    readonly token: ReferenceToken,
    readonly callbacks: ReferenceDecorationCallbacks,
    /** The length of the source text the chip stands for. */
    readonly length: number,
    /** The chip is inside the selection. The selection layer is measured from
     *  text and leaves a chip out, so the chip paints the highlight itself. */
    readonly isSelected: boolean,
  ) {
    super();
  }

  eq(other: ReferenceWidget): boolean {
    return this.length === other.length && this.isSelected === other.isSelected &&
      serializeReferenceToken(this.token) === serializeReferenceToken(other.token);
  }

  toDOM(view: EditorView): HTMLElement {
    const click = tokenClick(this.token, this.callbacks);
    const element: HTMLElement = document.createElement(click ? "button" : "span");
    if (element instanceof HTMLButtonElement) element.type = "button";
    element.className = referenceTokenClassName(this.token);
    if (this.isSelected) element.classList.add("solus-token--selected");
    element.contentEditable = "false";
    element.spellcheck = false;
    element.dataset.referenceKind = this.token.kind;
    if (this.token.kind === "file") element.dataset.fileRef = this.token.path;
    appendTokenIcon(element, this.token);
    const label = document.createElement("span");
    label.textContent = tokenLabel(this.token);
    element.appendChild(label);
    element.addEventListener("mousedown", (event: MouseEvent) => {
      if (event.button !== 0 || element.draggable) return;
      // Keeps the focus in the editor and the caret where it was.
      event.preventDefault();
      selectFromChip(view, element, this.length, event, click !== null);
    });
    if (click) {
      element.tabIndex = -1;
      element.addEventListener("click", click);
    }
    return element;
  }

  // The chip handles its own presses. The editor still sees the pointer move
  // over it, so a drag that reaches the chip can take it in.
  ignoreEvent(event: Event): boolean {
    return event.type !== "mousemove";
  }
}

function buildDecorations(
  state: EditorState,
  ranges: readonly ReferenceTokenRange[],
  config: ReferenceDecorationConfig,
  revealedFileStart: number | null,
): DecorationSet {
  const cursor = state.selection.main.head;
  const isInSelection = (range: ReferenceTokenRange) =>
    state.selection.ranges.some((selected) => !selected.empty && selected.from <= range.from && selected.to >= range.to);
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
          widget: new ReferenceWidget(range.token, config, range.to - range.from, isInSelection(range)),
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
  // The chip the pointer is over, so a pointer selection can take it whole.
  let chipUnderPointer: ReferenceTokenRange | null = null;

  /** A copy of a selection with chips in it: each chip as its readable text,
   *  and the HTML a paste restores the chips from (`reference-clipboard.ts`). */
  function writeReferenceCopy(event: ClipboardEvent, view: EditorView, isCut: boolean): boolean {
    const { ranges } = view.state.selection;
    const data = event.clipboardData;
    if (!data || ranges.length !== 1 || ranges[0].empty) return false;
    const { from, to } = ranges[0];
    const chips = view.state.field(field).ranges
      .filter((range) => range.from >= from && range.to <= to)
      .map((range) => ({ ...range, from: range.from - from, to: range.to - from }));
    if (chips.length === 0) return false;
    const copy = referenceClipboard(view.state.sliceDoc(from, to), chips);
    event.preventDefault();
    data.setData("text/plain", copy.plain);
    data.setData("text/html", copy.html);
    if (isCut && view.state.facet(EditorView.editable)) {
      view.dispatch({ changes: { from, to }, userEvent: "delete.cut", scrollIntoView: true });
    }
    return true;
  }
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
      EditorView.domEventHandlers({
        mousemove(event, view) {
          const chip = event.target instanceof Element ? event.target.closest(".solus-token") : null;
          const from = chip && view.contentDOM.contains(chip) ? view.posAtDOM(chip) : null;
          chipUnderPointer = from === null
            ? null
            : (view.state.field(field).ranges.find((range) => range.from === from) ?? null);
          return false;
        },
        mouseleave() {
          chipUnderPointer = null;
          return false;
        },
        copy: (event, view) => writeReferenceCopy(event, view, false),
        cut: (event, view) => writeReferenceCopy(event, view, true),
        paste(event, view) {
          const data = event.clipboardData;
          const text = data ? restoreReferences(data.getData("text/plain"), data.getData("text/html"), getConfig()) : null;
          if (text === null) return false;
          event.preventDefault();
          view.dispatch({ ...view.state.replaceSelection(text), userEvent: "input.paste", scrollIntoView: true });
          return true;
        },
      }),
      // A pointer that reaches a chip takes it in, as it does in a message.
      // CodeMirror puts the head at the chip's nearer edge, so a drag that
      // ended on the chip's first half left it out.
      EditorState.transactionFilter.of((transaction) => {
        const chip = chipUnderPointer;
        const selection = transaction.selection;
        if (!chip || !selection || transaction.docChanged || !transaction.isUserEvent("select.pointer")) return transaction;
        if (selection.ranges.length !== 1 || selection.main.empty) return transaction;
        const { anchor, head } = selection.main;
        const farEdge = anchor <= chip.from ? chip.to : anchor >= chip.to ? chip.from : head;
        if (farEdge === head) return transaction;
        return {
          selection: EditorSelection.single(anchor, farEdge),
          effects: transaction.effects,
          scrollIntoView: transaction.scrollIntoView,
          userEvent: "select.pointer",
        };
      }),
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

export interface TriggerReplacementResult {
  changed: boolean;
  from: number;
}

export function replaceTriggerAtCursor(
  view: EditorView,
  triggerPattern: RegExp,
  replacement: string,
): TriggerReplacementResult {
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
