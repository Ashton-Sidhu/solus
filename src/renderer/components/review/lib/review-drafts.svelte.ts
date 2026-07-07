import type { ReviewDraftComment, ReviewState } from "../../../../shared/review";
import type { DiffComment, IpcContext } from "../../../../shared/types";
import type { GuideDiffCommentSave } from "../../pr-review/guide/lib/guide-data";

/**
 * Review-draft comments for one guide key, persisted through the review-state
 * store (`.solus/review-state/<key>.json`). Owned by a host surface — the PR
 * review pane (drafts become a GitHub review) and the local review guide pane
 * (drafts become agent feedback) — and handed to GuideView / DiffPanel as
 * `DiffComment`s.
 */
export class ReviewDrafts {
  drafts = $state<ReviewDraftComment[]>([]);
  readonly diffComments: DiffComment[] = $derived(this.drafts.map(toDiffComment));

  #loadedKey: string | null = null;
  #opts: { getCtx: () => IpcContext; getKey: () => string };

  constructor(opts: { getCtx: () => IpcContext; getKey: () => string }) {
    this.#opts = opts;
  }

  /** Load the drafts for the current key (no-op if that key is already loaded). */
  async load(): Promise<void> {
    const key = this.#opts.getKey();
    if (key === this.#loadedKey) return;
    this.#loadedKey = key;
    try {
      const state = await window.solus.readReviewState(this.#opts.getCtx(), key);
      if (this.#opts.getKey() !== key) return;
      this.drafts = state?.drafts ?? [];
    } catch {
      // Never carry the previous key's drafts forward: a failed read for PR B
      // must not leave PR A's drafts live (they'd persist — and submit — under
      // B's key).
      if (this.#opts.getKey() === key) this.drafts = [];
    }
  }

  /** Upsert from a guide/diff comment card (edit when `id` is set, otherwise
   *  keyed on the path/side/line anchor). */
  save(comment: GuideDiffCommentSave): void {
    if (comment.id) {
      const draft = this.drafts.find((d) => d.id === comment.id);
      if (draft) draft.body = comment.comment;
    } else {
      this.#upsert({
        path: comment.filePath,
        line: comment.endLine,
        startLine: comment.startLine !== comment.endLine ? comment.startLine : undefined,
        side: comment.side,
        body: comment.comment,
      });
    }
    void this.#persist();
  }

  remove(id: string): void {
    const index = this.drafts.findIndex((d) => d.id === id);
    if (index === -1) return;
    this.drafts.splice(index, 1);
    void this.#persist();
  }

  clear(): void {
    if (this.drafts.length === 0) return;
    this.drafts.splice(0, this.drafts.length);
    void this.#persist();
  }

  #upsert(input: Omit<ReviewDraftComment, "id" | "createdAt">): void {
    const anchor = `${input.path}::${input.side}::${input.line}`;
    const existing = this.drafts.find(
      (d) => `${d.path}::${d.side}::${d.line}` === anchor,
    );
    if (existing) {
      existing.body = input.body;
      existing.startLine = input.startLine;
    } else {
      this.drafts.push({ id: crypto.randomUUID(), createdAt: Date.now(), ...input });
    }
  }

  #persist(): Promise<boolean> {
    const state: ReviewState = {
      version: 1,
      key: this.#opts.getKey(),
      drafts: [...this.drafts],
    };
    return window.solus.writeReviewState(this.#opts.getCtx(), state);
  }
}

function toDiffComment(draft: ReviewDraftComment): DiffComment {
  return {
    id: draft.id,
    filePath: draft.path,
    startLine: draft.startLine ?? draft.line,
    endLine: draft.line,
    side: draft.side,
    selectedCode: "",
    comment: draft.body,
    createdAt: draft.createdAt,
  };
}
