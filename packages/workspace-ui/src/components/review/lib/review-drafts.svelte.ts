import type { PrReviewDraftScope, ReviewDraftComment, ReviewState } from "@solus/contracts/review";
import type { DiffComment, IpcContext } from "@solus/contracts/types";
import { uuid } from "@solus/contracts/uuid";
import type { GuideDiffCommentSave } from "../../pr-review/guide/lib/guide-data";
import type { HostApi } from "@solus/client-core/host-api";

interface ReviewDraftOptions {
  getApi: () => HostApi;
  getCtx: () => IpcContext;
  key: string;
  pullRequest?: PrReviewDraftScope;
  canWrite?: () => boolean;
}

/** One saved review shared by the review form, guide, lens and diff panes. */
export class ReviewDrafts {
  drafts = $state<ReviewDraftComment[]>([]);
  readonly diffComments: DiffComment[] = $derived(this.drafts.map(toDiffComment));
  ready = $state(false);
  loadFailed = $state(false);
  saveFailed = $state(false);
  #summary = $state("");
  #loading: Promise<void> | null = null;
  #writeVersion = 0;

  constructor(private readonly options: ReviewDraftOptions) {}

  get summary(): string {
    return this.#summary;
  }

  set summary(value: string) {
    if (!this.ready || value === this.#summary) return;
    this.#summary = value;
    void this.persist();
  }

  async load(): Promise<void> {
    const { key } = this.options;
    if (!key || this.ready) return;
    if (this.#loading) return this.#loading;
    this.loadFailed = false;
    this.#loading = this.#read();
    try {
      await this.#loading;
    } finally {
      this.#loading = null;
    }
  }

  async #read(): Promise<void> {
    const { getApi, getCtx, key, pullRequest } = this.options;
    try {
      const state = await getApi().readReviewState(getCtx(), key, pullRequest);
      // Older hosts ignore the PR scope and return branch state without a summary.
      if (pullRequest && typeof state?.summary !== "string") throw new Error("Review drafts are unavailable");
      this.drafts = state?.drafts ?? [];
      this.#summary = state?.summary ?? "";
      this.ready = true;
    } catch {
      this.loadFailed = true;
    }
  }

  /** Upsert from a guide/diff comment card (edit when `id` is set, otherwise
   *  keyed on the path/side/line anchor). Returns the draft's id. */
  save(comment: GuideDiffCommentSave): string | null {
    if (!this.ready) return null;
    let id: string | null = null;
    if (comment.id) {
      const draft = this.drafts.find((d) => d.id === comment.id);
      if (draft) {
        draft.body = comment.comment;
        id = draft.id;
      }
    } else {
      id = this.#upsert({
        path: comment.filePath,
        line: comment.endLine,
        startLine: comment.startLine !== comment.endLine ? comment.startLine : undefined,
        side: comment.side,
        body: comment.comment,
      });
    }
    if (id) void this.persist();
    return id;
  }

  remove(id: string): void {
    const index = this.drafts.findIndex((d) => d.id === id);
    if (index === -1) return;
    this.drafts.splice(index, 1);
    void this.persist();
  }

  /** A reply from the provider may arrive after another pane edits a draft. */
  captureSubmission(): () => Promise<void> {
    const summary = this.#summary;
    const comments = new Map(this.drafts.map((draft) => [draft.id, JSON.stringify(draft)]));
    return async () => {
      if (this.options.canWrite?.() === false) return;
      let changed = false;
      if (summary && this.#summary === summary) {
        this.#summary = "";
        changed = true;
      }
      for (let index = this.drafts.length - 1; index >= 0; index--) {
        const draft = this.drafts[index];
        if (comments.get(draft.id) === JSON.stringify(draft)) {
          this.drafts.splice(index, 1);
          changed = true;
        }
      }
      if (changed) await this.persist();
    };
  }

  #upsert(input: Omit<ReviewDraftComment, "id" | "createdAt">): string {
    const anchor = `${input.path}::${input.side}::${input.line}`;
    const existing = this.drafts.find(
      (d) => `${d.path}::${d.side}::${d.line}` === anchor,
    );
    if (existing) {
      existing.body = input.body;
      existing.startLine = input.startLine;
      return existing.id;
    }
    const id = uuid();
    this.drafts.push({ id, createdAt: Date.now(), ...input });
    return id;
  }

  async persist(): Promise<void> {
    const { getApi, getCtx, key, pullRequest, canWrite } = this.options;
    if (!this.ready || canWrite?.() === false) return;
    const state: ReviewState = {
      version: 1,
      key,
      drafts: this.drafts.map((draft) => ({ ...draft })),
      summary: this.#summary,
    };
    // Send immediately so a window close cannot strand a write in a client queue.
    // The host commits writes for one scope in arrival order.
    const version = ++this.#writeVersion;
    try {
      const saved = await getApi().writeReviewState(getCtx(), state, pullRequest);
      if (this.#writeVersion === version) this.saveFailed = !saved;
    } catch {
      if (this.#writeVersion === version) this.saveFailed = true;
    }
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
