import type { FileDiffMetadata } from "@pierre/diffs";
import type { ReviewGuide, ReviewLedger, ReviewProgressStep } from "@solus/contracts/review";
import type { AgentId, DiffScope, IpcContext, ReasoningEffort } from "@solus/contracts/types";
import { loadDiffFiles as loadScopedDiffFiles } from "../../../lib/diff-file-loader";
import { requestInputFocus } from "../../../lib/inputFocus";
import type { HostApi } from "@solus/client-core/host-api";
import { serverConnections } from "@solus/client-core/server-connections";

export interface GuideLoaderOptions {
  /** RPC surface that owns the review checkout. */
  getApi: () => HostApi;
  /** The session IPC context to issue calls against. */
  getCtx: () => IpcContext;
  /** Stable cached-guide key (sanitized branch name or `session-<id>`). */
  getKey: () => string;
  /** `'session'` regenerates against the session base; `'branch'` (default) is
   *  the full-branch walkthrough. The stable key identifies storage; scope tells
   *  the producer which point-in-time diff base to record. */
  getScope: () => "branch" | "session";
  /** Present only while a PR is using its live stacked-parent base. */
  getOwnDeltaBase?: () => { parent: number; headSha: string } | null;
  /** Effective agent/model/reasoning for a fresh generation. */
  getAgent: () => { agent: AgentId; model: string | null; reasoningEffort: ReasoningEffort | null };
}

/**
 * Loads the structured review guide for a key plus its ledger + episode diff, and
 * hands them to the native GuideView. Prefers the cached guide; generates on
 * first open (or `refresh()`) and streams the producer's phase.
 *
 * Pure data layer: it owns no chrome. Each host instantiates one and drives the
 * initial/key-change load from its own `$effect` (so the loader stays free of an
 * effect root). `$state` fields make every field reactive for the host's markup.
 */
export class GuideLoader {
  guide = $state<ReviewGuide | null>(null);
  ledger = $state<ReviewLedger | null>(null);
  patch = $state("");
  diffScope = $state<Extract<DiffScope, { kind: "pr" }> | null>(null);
  loading = $state(true);
  progressStep = $state<ReviewProgressStep>("preparing");
  /** A cached guide whose `headSha` no longer matches the checkout's HEAD —
   *  the walkthrough describes an older state of the change. Commit-level
   *  only: working-tree edits don't move HEAD, so those stay undetected. */
  stale = $state(false);

  #opts: GuideLoaderOptions;
  constructor(opts: GuideLoaderOptions) {
    this.#opts = opts;
  }

  async load(regenerate: boolean, generateIfMissing = true): Promise<void> {
    const ctx = this.#opts.getCtx();
    const key = this.#opts.getKey();
    const api = this.#opts.getApi();
    this.loading = true;
    this.stale = false;
    // Prefer the cached guide; regenerate (or generate-on-first-open) otherwise.
    const cached = regenerate ? null : await api.readGuide(ctx, key);
    if (cached) {
      this.guide = cached;
    } else if (!generateIfMissing) {
      this.guide = null;
      this.ledger = null;
      this.patch = "";
      this.loading = false;
      return;
    } else {
      this.progressStep = "preparing";
      // Match progress events to this key's generation (events broadcast to
      // every subscriber); drop ones for other keys.
      const unsubscribe = serverConnections.eventsForApi(api).subscribe('review.progressChanged', (event) => {
        if (event.key !== key) return;
        this.progressStep = event.step;
      });
      try {
        const generated = await api.generateGuide(ctx, {
          ...this.#opts.getAgent(),
          scope: this.#opts.getScope(),
          ownDeltaBase: this.#opts.getOwnDeltaBase?.() ?? undefined,
        });
        this.guide = generated?.guide ?? null;
      } finally {
        unsubscribe();
      }
    }

    if (this.guide && this.guide.sections.length > 0) {
      const [reviewCtx, loadedLedger] = await Promise.all([
        api.getReviewContext(ctx),
        api.readLedger(ctx),
      ]);
      this.ledger = loadedLedger;
      // Only a cached guide can be stale — a fresh generation just ran.
      this.stale = !!(
        cached &&
        cached.headSha &&
        reviewCtx?.headSha &&
        cached.headSha !== reviewCtx.headSha
      );
      // Re-derive the patch from the guide's own base so a session walkthrough
      // shows only this session's diff (not the whole branch). Older cached guides
      // predate `baseSha`, so fall back to the branch base.
      const baseSha = this.guide.baseSha ?? reviewCtx?.baseSha ?? null;
      this.diffScope = baseSha ? { kind: "pr", baseSha } : null;
      const patch = this.diffScope
        ? await api.diff(ctx, { scope: this.diffScope }).catch(() => null)
        : null;
      this.patch = patch?.patch ?? "";
    } else {
      this.ledger = null;
      this.patch = "";
      this.diffScope = null;
    }

    this.loading = false;
  }

  refresh(): void {
    void this.load(true);
    requestInputFocus();
  }

  /**
   * Follow generation progress for this key for as long as the host is mounted.
   *
   * `load()` subscribes only around its *own* `generateGuide` call, which misses
   * the case the "Generate guide" button actually takes: that queues a durable
   * background generation (`requestReviewGuide`), so this loader never enters
   * `loading` and the stepped progress screen never appeared. Both paths
   * broadcast the same `review.progressChanged`, so listening for the loader's
   * lifetime is what makes background generation legible.
   *
   * Returns an unsubscribe, for the host's `$effect`.
   */
  trackProgress(): () => void {
    const api = this.#opts.getApi();
    return serverConnections.eventsForApi(api).subscribe('review.progressChanged', (event) => {
      // Events broadcast to every subscriber; keep only this key's, and read the
      // key per event so a key change mid-flight doesn't adopt stale progress.
      if (event.key !== this.#opts.getKey()) return;
      this.progressStep = event.step;
    });
  }

  loadDiffFiles = (fileDiff: FileDiffMetadata) => {
    if (!this.diffScope) {
      throw new Error("Review comparison is unavailable");
    }
    return loadScopedDiffFiles(
      this.#opts.getApi(),
      this.#opts.getCtx(),
      this.diffScope,
      fileDiff,
    );
  };
}
