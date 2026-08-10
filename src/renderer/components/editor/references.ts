// Editor-agnostic reference primitives. These operate on a Tiptap `Editor`
// instance rather than any component, so reference autocomplete can attach to
// any editor host (prompt input today, the document editor later).
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import type { PlanRefAttrs } from "./planRefExtension";
import type { PrRefAttrs } from "./prRefExtension";
import type { WorkRefAttrs } from "./workRefExtension";
import type { FileRefAttrs } from "./fileRefExtension";
import type { SlashRefAttrs } from "./slashRefExtension";
import type { SessionRefAttrs } from "./sessionRefExtension";
import { serializeReferenceToken, type ReferenceToken } from "./reference-tokens";
import type {
  PlanReference,
  WorkReference,
  SessionReference,
} from "../../../shared/types";

type ProseMirrorNode = Editor["state"]["doc"];
type ResolvedPos = Editor["state"]["selection"]["$head"];

export function textBeforeCursor(editor: Editor | null): string {
  if (!editor) return "";
  const sel = editor.state.selection;
  return editor.state.doc.textBetween(sel.$head.start(), sel.from);
}

export function isCaretAtStart(editor: Editor | null): boolean {
  if (!editor) return false;
  return editor.state.selection.from === 1;
}

export function isCaretAtLineEnd(editor: Editor | null): boolean {
  if (!editor) return true;
  const selection = editor.state.selection;
  return selection.from === selection.$head.end();
}

// Converts a text-space index (from textBetween) to an absolute document
// position, correctly accounting for inline atom nodes that textBetween skips.
function findTriggerDocPos(
  head: ResolvedPos,
  selFrom: number,
  textIdx: number,
): number {
  let textSeen = 0;
  let found = false;
  let docPos = selFrom;

  head.parent.forEach((child: ProseMirrorNode, offset: number) => {
    if (found) return;
    const childDocPos = head.start() + offset;
    if (childDocPos >= selFrom) return;
    if (child.isText) {
      const len = Math.min(child.text?.length ?? 0, selFrom - childDocPos);
      if (textSeen + len > textIdx) {
        docPos = childDocPos + (textIdx - textSeen);
        found = true;
      } else {
        textSeen += len;
      }
    }
    // Atom nodes don't contribute to textSeen; their doc offset is already
    // baked into childDocPos via the forEach offset parameter.
  });

  return docPos;
}

function insertReferenceNode(
  editor: Editor | null,
  nodeName: string,
  attrs: Record<string, unknown>,
  triggerPattern: RegExp,
): boolean {
  if (!editor) return false;
  const sel = editor.state.selection;
  const head = sel.$head;
  const textBefore = editor.state.doc.textBetween(head.start(), sel.from);
  const match = textBefore.match(triggerPattern);

  const { tr, schema } = editor.state;
  const nodeType = schema.nodes[nodeName];
  if (!nodeType) return false;

  const node = nodeType.create(attrs);

  if (match && match.index !== undefined) {
    const matchStart = match[0].length - match[0].trimStart().length;
    const deleteFrom = findTriggerDocPos(
      head,
      sel.from,
      match.index + matchStart,
    );
    tr.delete(deleteFrom, sel.from);
    tr.insert(deleteFrom, node);
    tr.insertText(" ");
  } else {
    tr.insert(sel.from, node);
    tr.insertText(" ");
  }

  editor.view.dispatch(tr);
  return true;
}

export function updateTriggerText(
  editor: Editor | null,
  triggerPattern: RegExp,
  replacement: string,
): boolean {
  if (!editor) return false;
  const sel = editor.state.selection;
  const head = sel.$head;
  const textBefore = editor.state.doc.textBetween(head.start(), sel.from);
  const match = textBefore.match(triggerPattern);
  if (!match || match.index === undefined) return false;

  const matchStart = match[0].length - match[0].trimStart().length;
  const deleteFrom = findTriggerDocPos(head, sel.from, match.index + matchStart);
  const { tr } = editor.state;
  tr.delete(deleteFrom, sel.from);
  tr.insertText(replacement, deleteFrom);
  editor.view.dispatch(tr);
  return true;
}

/** Turn the file chip at `pos` back into its `@path` trigger text, caret at the
 *  end. The editor update that follows re-opens the file menu at that path.
 *  A folder chip's trailing `/` is dropped so the menu searches at that level
 *  and surfaces the siblings, instead of browsing back into the folder. */
export function unwrapFileReference(editor: Editor | null, pos: number): boolean {
  if (!editor) return false;
  const node = editor.state.doc.nodeAt(pos);
  if (!node || node.type.name !== "fileReference") return false;

  const text = `@${String(node.attrs.path ?? "").replace(/\/+$/, "")}`;
  const { tr, schema } = editor.state;
  tr.replaceWith(pos, pos + node.nodeSize, schema.text(text));
  tr.setSelection(TextSelection.create(tr.doc, pos + text.length));
  editor.view.dispatch(tr);
  return true;
}

export function insertPlanReference(
  editor: Editor | null,
  attrs: PlanRefAttrs,
  triggerPattern: RegExp,
): boolean {
  return insertReferenceNode(
    editor,
    "planReference",
    attrs as unknown as Record<string, unknown>,
    triggerPattern,
  );
}

export function insertWorkReference(
  editor: Editor | null,
  attrs: WorkRefAttrs,
  triggerPattern: RegExp,
): boolean {
  return insertReferenceNode(
    editor,
    "workReference",
    attrs as unknown as Record<string, unknown>,
    triggerPattern,
  );
}

export function insertPrReference(
  editor: Editor | null,
  attrs: PrRefAttrs,
  triggerPattern: RegExp,
): boolean {
  return insertReferenceNode(
    editor,
    "prReference",
    attrs as unknown as Record<string, unknown>,
    triggerPattern,
  );
}

export function insertFileReference(
  editor: Editor | null,
  attrs: FileRefAttrs,
  triggerPattern: RegExp,
): boolean {
  return insertReferenceNode(
    editor,
    "fileReference",
    attrs as unknown as Record<string, unknown>,
    triggerPattern,
  );
}

export function insertSlashReference(
  editor: Editor | null,
  attrs: SlashRefAttrs,
  triggerPattern: RegExp,
): boolean {
  return insertReferenceNode(
    editor,
    "slashReference",
    attrs as unknown as Record<string, unknown>,
    triggerPattern,
  );
}

export function insertSessionReference(
  editor: Editor | null,
  attrs: SessionRefAttrs,
  triggerPattern: RegExp,
): boolean {
  return insertReferenceNode(
    editor,
    "sessionReference",
    attrs as unknown as Record<string, unknown>,
    triggerPattern,
  );
}

export function insertReference(
  editor: Editor | null,
  token: ReferenceToken,
  triggerPattern: RegExp,
): boolean {
  switch (token.kind) {
    case "file": {
      const { kind: _, ...attrs } = token;
      return insertFileReference(editor, attrs, triggerPattern);
    }
    case "plan": {
      const { kind: _, ...attrs } = token;
      return insertPlanReference(editor, attrs, triggerPattern);
    }
    case "work": {
      const { kind: _, ...attrs } = token;
      return insertWorkReference(editor, attrs, triggerPattern);
    }
    case "pr": {
      const { kind: _, ...attrs } = token;
      return insertPrReference(editor, attrs, triggerPattern);
    }
    case "slash": {
      const { kind: _, ...attrs } = token;
      return insertSlashReference(editor, attrs, triggerPattern);
    }
    case "session": {
      const { kind: _, ...attrs } = token;
      return insertSessionReference(editor, attrs, triggerPattern);
    }
    // Tasks and automations have no Tiptap node of their own — the document
    // editor is not where you act on them. Their markdown link round-trips
    // through the same parser the CodeMirror chip is built from.
    case "task":
    case "automation":
      return updateTriggerText(
        editor,
        triggerPattern,
        `${serializeReferenceToken(token)} `,
      );
  }
}

// Single combined walk for both reference kinds. syncRefs runs on every editor
// update, so pull plan + work refs from one doc.descendants pass rather than
// two independent full walks (each of which allocated its own Set + array).
export function extractRefs(editor: Editor | null): {
  planRefs: PlanReference[];
  workRefs: WorkReference[];
  sessionRefs: SessionReference[];
} {
  const planRefs: PlanReference[] = [];
  const workRefs: WorkReference[] = [];
  const sessionRefs: SessionReference[] = [];
  if (!editor) return { planRefs, workRefs, sessionRefs };
  const seenPlans = new Set<string>();
  const seenWorks = new Set<string>();
  const seenSessions = new Set<string>();
  editor.state.doc.descendants((node) => {
    const name = node.type.name;
    if (
      name === "planReference" &&
      node.attrs.planId &&
      !seenPlans.has(node.attrs.planId)
    ) {
      seenPlans.add(node.attrs.planId);
      planRefs.push({
        planId: node.attrs.planId,
        sessionId: node.attrs.sessionId,
        planToolUseId: node.attrs.planToolUseId,
        title: node.attrs.title,
        status: node.attrs.status,
      });
    } else if (
      name === "workReference" &&
      node.attrs.workId &&
      !seenWorks.has(node.attrs.workId)
    ) {
      seenWorks.add(node.attrs.workId);
      workRefs.push({
        workId: node.attrs.workId,
        title: node.attrs.title,
        type: node.attrs.type,
      });
    } else if (
      name === "sessionReference" &&
      node.attrs.sessionId &&
      !seenSessions.has(node.attrs.sessionId)
    ) {
      seenSessions.add(node.attrs.sessionId);
      sessionRefs.push({
        sessionId: node.attrs.sessionId,
        provider: node.attrs.provider,
        title: node.attrs.title,
        cwd: node.attrs.cwd,
      });
    }
  });
  return { planRefs, workRefs, sessionRefs };
}
