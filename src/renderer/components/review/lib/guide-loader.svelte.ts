import type { ReviewGuide, ReviewLedger, ReviewProgressStep } from "../../../../shared/review";
import type { AgentId, IpcContext, ReasoningEffort } from "../../../../shared/types";
import { requestInputFocus } from "../../../lib/inputFocus";

export interface GuideLoaderOptions {
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
    this.loading = true;
    this.stale = false;
    // Prefer the cached guide; regenerate (or generate-on-first-open) otherwise.
    const cached = regenerate ? null : await window.solus.readGuide(ctx, key);
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
      const unsubscribe = window.solus.onReviewProgress((event) => {
        if (event.key !== key) return;
        this.progressStep = event.step;
      });
      try {
        const generated = await window.solus.generateGuide(ctx, {
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
        window.solus.getReviewContext(ctx),
        window.solus.readLedger(ctx),
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
      this.patch = baseSha
        ? (await window.solus.diff(ctx, { scope: { kind: "pr", baseSha } }).catch(() => null))?.patch ?? ""
        : "";
    } else {
      this.ledger = null;
      this.patch = "";
    }

    this.loading = false;
  }

  refresh(): void {
    void this.load(true);
    requestInputFocus();
  }
}
