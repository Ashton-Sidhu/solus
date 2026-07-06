// Editor-agnostic reference primitives. These operate on a Tiptap `Editor`
// instance rather than any component, so reference autocomplete can attach to
// any editor host (prompt input today, the document editor later).
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode, ResolvedPos } from "@tiptap/pm/model";
import type { PlanRefAttrs } from "./planRefExtension";
import type { WorkRefAttrs } from "./workRefExtension";
import type { FileRefAttrs } from "./fileRefExtension";
import type { SlashRefAttrs } from "./slashRefExtension";
import type { PlanReference, WorkReference } from "../../../shared/types";

export function textBeforeCursor(editor: Editor | null): string {
  if (!editor) return "";
  const sel = editor.state.selection;
  return editor.state.doc.textBetween(sel.$head.start(), sel.from);
}

export function isCaretAtStart(editor: Editor | null): boolean {
  if (!editor) return false;
  return editor.state.selection.from === 1;
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
) {
  if (!editor) return;
  const sel = editor.state.selection;
  const head = sel.$head;
  const textBefore = editor.state.doc.textBetween(head.start(), sel.from);
  const match = textBefore.match(triggerPattern);

  const { tr, schema } = editor.state;
  const nodeType = schema.nodes[nodeName];
  if (!nodeType) return;

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
}

export function updateTriggerText(
  editor: Editor | null,
  triggerPattern: RegExp,
  replacement: string,
) {
  if (!editor) return;
  const sel = editor.state.selection;
  const head = sel.$head;
  const textBefore = editor.state.doc.textBetween(head.start(), sel.from);
  const match = textBefore.match(triggerPattern);
  if (!match || match.index === undefined) return;

  const matchStart = match[0].length - match[0].trimStart().length;
  const deleteFrom = findTriggerDocPos(head, sel.from, match.index + matchStart);
  const { tr } = editor.state;
  tr.delete(deleteFrom, sel.from);
  tr.insertText(replacement, deleteFrom);
  editor.view.dispatch(tr);
}

export function insertPlanReference(
  editor: Editor | null,
  attrs: PlanRefAttrs,
  triggerPattern: RegExp,
) {
  insertReferenceNode(
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
) {
  insertReferenceNode(
    editor,
    "workReference",
    attrs as unknown as Record<string, unknown>,
    triggerPattern,
  );
}

export function insertFileReference(
  editor: Editor | null,
  attrs: FileRefAttrs,
  triggerPattern: RegExp,
) {
  insertReferenceNode(
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
) {
  insertReferenceNode(
    editor,
    "slashReference",
    attrs as unknown as Record<string, unknown>,
    triggerPattern,
  );
}

// Single combined walk for both reference kinds. syncRefs runs on every editor
// update, so pull plan + work refs from one doc.descendants pass rather than
// two independent full walks (each of which allocated its own Set + array).
export function extractRefs(editor: Editor | null): {
  planRefs: PlanReference[];
  workRefs: WorkReference[];
} {
  const planRefs: PlanReference[] = [];
  const workRefs: WorkReference[] = [];
  if (!editor) return { planRefs, workRefs };
  const seenPlans = new Set<string>();
  const seenWorks = new Set<string>();
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
    }
  });
  return { planRefs, workRefs };
}
