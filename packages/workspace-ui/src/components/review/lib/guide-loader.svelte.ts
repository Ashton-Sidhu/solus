import type { FileDiffLoadedFiles, FileDiffMetadata } from "@pierre/diffs";
import { reviewGuideTargetId } from "@solus/contracts/review";
import type { ReviewContext, ReviewGuide, ReviewGuideRequestOptions, ReviewLedger, ReviewProgressStep, ReviewTarget } from "@solus/contracts/review";
import type { AgentId, DiffScope, IpcContext, ReasoningEffort } from "@solus/contracts/types";
import { loadDiffFiles as loadScopedDiffFiles } from "../../../lib/diff-file-loader";
import { requestInputFocus } from "../../../lib/inputFocus";
import type { HostApi } from "@solus/client-core/host-api";
import { serverConnections } from "@solus/client-core/server-connections";

export interface GuideLoaderOptions {
  /** RPC surface that owns the review checkout. */
  getApi: () => HostApi;
  /** The host that surface belongs to, for the progress subscription. Named by
   *  the caller rather than recovered from `getApi()`: an id is a stable name,
   *  an API object is only a key while it is the registry's live connection. */
  getServerId: () => string;
  /** The session IPC context to issue calls against. */
  getCtx: () => IpcContext;
  /** Stable cached-guide key (sanitized branch name or `session-<id>`). */
  getKey: () => string;
  /** `'session'` regenerates against the session base; `'branch'` (default) is
   *  the full-branch walkthrough. The stable key identifies storage; scope tells
   *  the producer which point-in-time diff base to record. */
  getScope: () => "branch" | "session";
  /** Typed target for a checkout prepared outside the source project. */
  getTarget?: () => ReviewTarget | undefined;
  /** Live provider revision; never infer PR freshness from an unrelated checkout. */
  getCurrentRevision?: () => { headSha?: string; baseSha?: string } | null;
  /** Present only while a PR is using its live stacked-parent base. */
  getOwnDeltaBase?: () => { parent: number; headSha: string } | null;
  /** Effective agent/model/reasoning for a fresh generation. */
  getAgent: () => { agent: AgentId; model: string | null; reasoningEffort: ReasoningEffort | null };
  /** The review context the host has already resolved for this checkout, when
   *  it has one. Reading it twice for one open is two round trips for one
   *  answer; a host without one omits this and the loader asks itself. */
  getResolvedReviewContext?: () => ReviewContext | null;
  /**
   * The patch for `scope` as the host's own diff surface has it, when that
   * surface is showing this exact comparison.
   *
   * A string — including the empty one, while the host's own load is still in
   * flight — means the host owns these bytes, so the loader neither requests
   * them again nor holds a second copy. `null` means the guide is comparing
   * something the host is not showing, and the loader loads it itself.
   */
  getHostPatch?: (scope: Extract<DiffScope, { kind: "pr" }>) => string | null;
}

function guideRequestOptions(
  opts: GuideLoaderOptions,
  regenerationBaseSha?: string,
): ReviewGuideRequestOptions {
  const target = opts.getTarget?.();
  return {
    ...opts.getAgent(),
    ...(target
      ? {
          target:
            regenerationBaseSha && target.kind === "pr"
              ? { ...target, baseSha: regenerationBaseSha }
              : target,
        }
      : { scope: opts.getScope() }),
    ownDeltaBase: opts.getOwnDeltaBase?.() ?? undefined,
    regenerationBaseSha,
  };
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
  diffScope = $state<Extract<DiffScope, { kind: "pr" }> | null>(null);
  // Background generation has its own status. Only an active load owns this flag.
  loading = $state(false);
  progressStep = $state<ReviewProgressStep>("preparing");
  /** A cached guide whose `headSha` no longer matches the checkout's HEAD —
   *  the walkthrough describes an older state of the change. Commit-level
   *  only: working-tree edits don't move HEAD, so those stay undetected. */
  error = $state<string | null>(null);
  #loadedRevision = $state<{ headSha?: string; baseSha?: string } | null>(null);
  #loadVersion = 0;
  #loadedIdentity = "";

  get stale(): boolean {
    const guide = this.guide;
    const revision = this.currentRevision;
    if (!guide || !revision) return false;
    return !!((guide.headSha && revision.headSha && guide.headSha !== revision.headSha)
      || (this.#opts.getTarget?.()?.kind === "pr" && guide.baseSha && revision.baseSha && guide.baseSha !== revision.baseSha));
  }

  get freshnessUnknown(): boolean {
    if (!this.guide) return false;
    const revision = this.currentRevision;
    return !this.guide.headSha || !revision?.headSha
      || (this.#opts.getTarget?.()?.kind === "pr" && (!this.guide.baseSha || !revision.baseSha));
  }

  private get currentRevision(): { headSha?: string; baseSha?: string } | null {
    const target = this.#opts.getTarget?.();
    if (this.#opts.getCurrentRevision) {
      const revision = this.#opts.getCurrentRevision();
      return revision ?? (target?.kind === "pr" ? null : this.#loadedRevision);
    }
    return target?.kind === "pr" ? target : this.#loadedRevision;
  }

  /** The patch the guide quotes its snippets from. Read through the host first,
   *  so a guide comparing what the host's diff already shows follows that one
   *  load instead of duplicating it. */
  get patch(): string {
    const scope = this.diffScope;
    const hosted = scope && this.guide ? this.#hostPatchFor(this.guide, scope, this.currentRevision) : null;
    return hosted ?? this.#loadedPatch;
  }

  #hostPatchFor(guide: ReviewGuide, scope: Extract<DiffScope, { kind: "pr" }>, revision: { headSha?: string; baseSha?: string } | null): string | null {
    if (this.#opts.getTarget?.()?.kind === "pr"
      && (guide.headSha !== revision?.headSha || guide.baseSha !== revision?.baseSha)) return null;
    return this.#opts.getHostPatch?.(scope) ?? null;
  }

  #loadedPatch = $state("");
  #opts: GuideLoaderOptions;
  constructor(opts: GuideLoaderOptions) {
    this.#opts = opts;
  }

  async load(
    regenerate: boolean,
    generateIfMissing = true,
    regenerationBaseSha?: string,
  ): Promise<void> {
    const ctx = this.#opts.getCtx();
    const key = this.#opts.getKey();
    const api = this.#opts.getApi();
    const serverId = this.#opts.getServerId();
    const target = this.#opts.getTarget?.();
    const identity = `${serverId}::${target ? reviewGuideTargetId(target) : key}`;
    const version = ++this.#loadVersion;
    const current = () => {
      const liveTarget = this.#opts.getTarget?.();
      return version === this.#loadVersion
        && identity === `${this.#opts.getServerId()}::${liveTarget ? reviewGuideTargetId(liveTarget) : this.#opts.getKey()}`;
    };
    if (identity !== this.#loadedIdentity) {
      this.guide = null;
      this.ledger = null;
      this.diffScope = null;
      this.#loadedPatch = "";
      this.#loadedRevision = null;
      this.#loadedIdentity = identity;
    }
    this.loading = true;
    this.error = null;
    try {
      const cached = regenerate ? null : await api.readGuide(ctx, key, target);
      if (!current()) return;
      let guide = cached;
      if (!guide && generateIfMissing) {
        this.progressStep = "preparing";
        const unsubscribe = serverConnections.eventsFor(serverId).subscribe('review.progressChanged', (event) => {
          if (current() && event.key === key) this.progressStep = event.step;
        });
        try {
          const generated = await api.generateGuide(ctx, guideRequestOptions(this.#opts, regenerationBaseSha));
          if (!current()) return;
          if (!generated || generated.outdated) throw new Error(generated?.outdated
            ? "The change moved while the guide was being generated. Generate it again."
            : "The guide could not be generated.");
          guide = generated.guide;
        } finally {
          unsubscribe();
        }
      }
      if (!current()) return;
      const comparison = await this.#loadComparison(api, ctx, guide, target, current);
      if (!current()) return;
      // Commit content and its comparison together. A failed replacement keeps
      // the previous guide, patch, and outdated warning intact.
      this.guide = guide;
      this.ledger = comparison.ledger;
      this.diffScope = comparison.diffScope;
      this.#loadedPatch = comparison.patch;
      this.#loadedRevision = comparison.revision;
    } catch (error) {
      if (!current()) return;
      this.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      if (version === this.#loadVersion) this.loading = false;
    }
  }

  async #loadComparison(
    api: HostApi,
    ctx: IpcContext,
    guide: ReviewGuide | null,
    target: ReviewTarget | undefined,
    current: () => boolean,
  ): Promise<{
    ledger: ReviewLedger | null;
    revision: { headSha?: string; baseSha?: string } | null;
    diffScope: Extract<DiffScope, { kind: "pr" }> | null;
    patch: string;
  }> {
    let ledger: ReviewLedger | null = null;
    let revision: { headSha?: string; baseSha?: string } | null = null;
    if (!guide || guide.sections.length === 0) return { ledger, revision, diffScope: null, patch: "" };
    if (target?.kind === "pr") {
      revision = this.currentRevision;
    } else {
      const hostContext = this.#opts.getResolvedReviewContext?.() ?? null;
      const [reviewContext, loadedLedger] = await Promise.all([
        hostContext ?? api.getReviewContext(ctx), api.readLedger(ctx),
      ]);
      revision = reviewContext;
      ledger = loadedLedger;
    }
    const baseSha = guide.baseSha ?? revision?.baseSha;
    const diffScope: Extract<DiffScope, { kind: "pr" }> | null = baseSha ? { kind: "pr", baseSha } : null;
    if (!current() || !diffScope || this.#hostPatchFor(guide, diffScope, revision) != null) {
      return { ledger, revision, diffScope, patch: "" };
    }
    const patch = target?.kind === "pr"
      ? await this.#loadPrPatch(api, ctx, target, guide, diffScope.baseSha, current)
      : (await api.diff(ctx, { scope: diffScope }))?.patch ?? "";
    return { ledger, revision, diffScope, patch };
  }

  async #loadPrPatch(
    api: HostApi,
    ctx: IpcContext,
    target: Extract<ReviewTarget, { kind: "pr" }>,
    guide: ReviewGuide,
    baseSha: string,
    current: () => boolean,
  ): Promise<string> {
    if (!guide.headSha) throw new Error("The saved guide has no review revision. Generate it again.");
    let cursor: string | undefined;
    const pages: string[] = [];
    do {
      const result = await api.prGetDiff(ctx, {
        repo: { host: target.host, owner: target.owner, repo: target.repo },
        number: target.number, baseSha, headSha: guide.headSha, cursor,
      });
      if (!current()) return "";
      pages.push(result.patch);
      if (result.truncated && !result.nextCursor) throw new Error("The guide comparison is too large to load completely.");
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
    return pages.join("\n");
  }

  refresh(mode: 'full' | 'new-commits' = 'full'): Promise<void> {
    const regenerationBaseSha = mode === 'new-commits'
      ? this.guide?.headSha
      : undefined;
    const loading = this.load(true, true, regenerationBaseSha);
    requestInputFocus();
    return loading;
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
    return serverConnections
      .eventsFor(this.#opts.getServerId())
      .subscribe('review.progressChanged', (event) => {
        // Events broadcast to every subscriber; keep only this key's, and read the
        // key per event so a key change mid-flight doesn't adopt stale progress.
        if (event.key !== this.#opts.getKey()) return;
        this.progressStep = event.step;
      });
  }

  loadDiffFiles = async (fileDiff: FileDiffMetadata): Promise<FileDiffLoadedFiles> => {
    const target = this.#opts.getTarget?.();
    const guide = this.guide;
    if (target?.kind === "pr") {
      if (!guide?.baseSha || !guide.headSha) throw new Error("The guide comparison is unavailable.");
      const result = await this.#opts.getApi().prGetDiffFileContents(this.#opts.getCtx(), {
        repo: { host: target.host, owner: target.owner, repo: target.repo },
        number: target.number, baseSha: guide.baseSha, headSha: guide.headSha,
        oldPath: fileDiff.prevName ?? fileDiff.name, newPath: fileDiff.name, changeType: fileDiff.type,
      });
      return {
        oldFile: fileDiff.type === "rename-pure" ? null : {
          name: fileDiff.prevName ?? fileDiff.name, contents: result.oldContents,
          cacheKey: `${guide.baseSha}:${fileDiff.prevName ?? fileDiff.name}`,
        },
        newFile: { name: fileDiff.name, contents: result.newContents, cacheKey: `${guide.headSha}:${fileDiff.name}` },
      };
    }
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
