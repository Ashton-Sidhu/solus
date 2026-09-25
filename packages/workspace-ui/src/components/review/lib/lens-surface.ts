import { z } from "zod";
import { uuid } from "@solus/contracts/uuid";
import type {
  ReviewDraftComment,
  ReviewLensCodeAnchor,
  ReviewLensJob,
  ReviewLensSnapshot,
  SavedLens,
} from "@solus/contracts/review";

/** What a pull-request review hands the Lens tab so a lens comment can reach
 *  the pull request: the draft review it adds line comments to, and the patch
 *  those lines are checked against. */
export interface LensPullRequestAdapter {
  canComment: boolean;
  commentReason?: string;
  patch: string | null;
  drafts: readonly ReviewDraftComment[];
  /** Add a draft line comment and return its id, or null when it was refused. */
  addDraft: (anchor: ReviewLensCodeAnchor, body: string) => string | null;
  removeDraft: (draftId: string) => void;
}

/** What the Lens tab shows beside its label. `attention` marks a failed run:
 *  the lens it kept is still there, but the user asked for something else. */
export type LensTabState = "absent" | "generating" | "unread" | "attention" | "ready";

export function isLensRunning(job: ReviewLensJob | null | undefined): boolean {
  return job?.status === "queued" || job?.status === "generating";
}

export function lensTabState(snapshot: ReviewLensSnapshot | null, unread: boolean): LensTabState {
  if (isLensRunning(snapshot?.job)) return "generating";
  if (snapshot?.job?.status === "failed") return "attention";
  if (unread) return "unread";
  return snapshot?.current ? "ready" : "absent";
}

const STEP_LABELS = {
  preparing: "Preparing the diff",
  analyzing: "Reading the change",
  writing: "Writing the lens",
} as const;

/** The one line a running job reads as. */
export function lensJobLabel(job: ReviewLensJob): string {
  if (job.status === "queued") return job.kind === "edit" ? "Edit queued" : "Lens queued";
  const verb = job.kind === "edit" ? "Editing the lens" : "Making the lens";
  return job.step ? `${verb} · ${STEP_LABELS[job.step]}` : verb;
}

/**
 * Lines on the new side of `path` that a pull-request line comment can target:
 * the added and context lines inside the diff's hunks. The code host refuses a
 * whole review when one draft points outside them, so a lens anchor is
 * checked against this before it becomes a draft.
 */
export function commentableNewLines(patch: string, path: string): Set<number> {
  const lines = new Set<number>();
  let inFile = false;
  let newLine = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const header = raw.match(/^diff --git a\/.+ b\/(.+)$/);
    if (header) {
      inFile = header[1] === path;
      inHunk = false;
      continue;
    }
    if (!inFile) continue;
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("+")) lines.add(newLine++);
    else if (raw.startsWith(" ")) lines.add(newLine++);
    else if (raw.startsWith("-") || raw.startsWith("\\")) continue;
    else inHunk = false;
  }
  return lines;
}

/** Why a lens comment cannot become a draft line comment, or null when it can.
 *  The anchor comes from the render, which an agent wrote, so it is checked
 *  here rather than trusted. */
export function draftLineRefusal(
  anchor: ReviewLensCodeAnchor | undefined,
  patch: string | null,
  drafts: readonly Pick<ReviewDraftComment, "path" | "line" | "side">[],
): string | null {
  if (!anchor) return "This part of the lens does not point at a line in the change.";
  if (patch === null) return "The diff is still loading.";
  if (!commentableNewLines(patch, anchor.path).has(anchor.line)) {
    return `${anchor.path}:${anchor.line} is not a line in this diff.`;
  }
  if (drafts.some((draft) => draft.path === anchor.path && draft.side === "new" && draft.line === anchor.line)) {
    return `There is already a draft on ${anchor.path}:${anchor.line}. Edit that draft in the diff.`;
  }
  return null;
}

/** A pin's client point, mapped into the frame's own coordinates, so the
 *  render can say what element sits under it. */
export function framePointForPin(
  pin: { x: number; y: number },
  layer: { left: number; top: number; width: number; height: number },
  frame: { left: number; top: number },
) {
  return {
    x: layer.left + pin.x * layer.width - frame.left,
    y: layer.top + pin.y * layer.height - frame.top,
  };
}

/** What a render says sits under a lens comment pin. */
export interface LensPinTarget {
  codeAnchor?: ReviewLensCodeAnchor;
  quote?: string;
}

/** The render's reply. A field of the wrong shape reads as absent: the render
 *  is agent-authored, so a bad anchor must cost the anchor, not the comment. */
export const anchorReplySchema = z.object({
  type: z.literal("solus-lens-anchor"),
  id: z.string(),
  path: z.string().nullable().optional().catch(undefined),
  line: z.number().int().positive().nullable().optional().catch(undefined),
  text: z.string().optional().catch(undefined),
});

/** The code anchor a render reported, kept only when it names a relative path
 *  and a real line. */
export function parseAnchorReply(reply: Pick<z.output<typeof anchorReplySchema>, "path" | "line" | "text">): LensPinTarget {
  const target: LensPinTarget = {};
  const quote = reply.text?.trim().slice(0, 280);
  if (quote) target.quote = quote;
  const path = reply.path?.trim();
  if (path && reply.line && !path.startsWith("/") && !path.includes("..")) {
    target.codeAnchor = { path, line: reply.line };
  }
  return target;
}

/** A saved lens made from a prompt the user typed once. Named by its first
 *  line; the user can rename it in Settings. */
export function savedLensFromPrompt(prompt: string): SavedLens {
  const firstLine = prompt.trim().split("\n")[0] ?? "";
  const name = firstLine.length > 48 ? `${firstLine.slice(0, 47).trimEnd()}…` : firstLine;
  return { id: uuid(), name: name || "Lens", prompt: prompt.trim() };
}

/** Starting points in Settings. The user edits them into their own. */
export const LENS_TEMPLATES: Omit<SavedLens, "id">[] = [
  {
    name: "Architecture delta",
    prompt:
      "Draw the modules and data flow this change touches as a diagram. Mark what is new, what changed, and what was removed. Link each box to the file and line that shows it.",
  },
  {
    name: "Risk by file",
    prompt:
      "Show every changed file as a row, ranked by review risk. For each, give the reason in one sentence and the lines a reviewer must read first.",
  },
  {
    name: "Data flow",
    prompt:
      "Trace how one request or event moves through the changed code, step by step. Show where data is read, transformed, and written, and link each step to its line.",
  },
];

const ANCHOR_REPLY_TIMEOUT_MS = 600;

/** Ask the lens render what sits under a point. Resolves with no anchor when
 *  the render does not answer in time: the comment is still worth keeping. */
export function queryLensAnchor(
  frame: HTMLIFrameElement,
  point: { x: number; y: number },
): Promise<LensPinTarget> {
  const target = frame.contentWindow;
  if (!target) return Promise.resolve({});
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish({}), ANCHOR_REPLY_TIMEOUT_MS);
    function finish(result: LensPinTarget) {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(result);
    }
    function onMessage(event: MessageEvent) {
      if (event.source !== target) return;
      const reply = anchorReplySchema.safeParse(event.data);
      if (!reply.success || reply.data.id !== id) return;
      finish(parseAnchorReply(reply.data));
    }
    window.addEventListener("message", onMessage);
    target.postMessage({ type: "solus-lens-anchor-query", id, x: point.x, y: point.y }, "*");
  });
}
