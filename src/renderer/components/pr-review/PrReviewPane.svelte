<script lang="ts">
  import { untrack } from "svelte";
  import { XIcon, ArrowsClockwiseIcon, ChatCircleIcon, ArrowSquareOutIcon } from "phosphor-svelte";
  import type { PrReviewContext, DiffScope, DiffComment } from "../../../shared/types";
  import type { ReviewThread } from "../../../shared/providers";
  import type { ReviewDraftComment, ReviewState } from "../../../shared/review";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { getSettingsContext } from "../../contexts/settings.context.svelte";
  import { getAgentContext } from "../../contexts/agent.context.svelte";
  import { resolveReviewAgent } from "../../lib/reviewAgent";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { tooltip } from "../../lib/tooltip";
  import GuideSurface from "../review/GuideSurface.svelte";
  import { GuideLoader } from "../review/lib/guide-loader.svelte";
  import DiffPanel from "../diff/DiffPanel.svelte";
  import ActivityFeed from "./ActivityFeed.svelte";
  import PendingReviewTray from "./PendingReviewTray.svelte";
  import SubmitReviewModal from "./SubmitReviewModal.svelte";

  type ReviewDiffCommentSave = {
    id?: string;
    filePath: string;
    startLine: number;
    endLine: number;
    side: "old" | "new";
    selectedCode: string;
    comment: string;
    createdAt?: number;
  };

  // The review surface (M3–M5): Activity · Guide · Diff content tabs over a PR's
  // change, living maximized in the secondary pane. The worktree-rooted chat is
  // the primary conversation — the "Chat" button un-maximizes to pop it out.
  let {
    pr,
    chatTabId,
    guideKey,
    onToggleSecondaryMaximize,
  }: {
    pr: PrReviewContext;
    chatTabId: string;
    guideKey: string;
    onToggleSecondaryMaximize?: () => void;
  } = $props();

  const session = getWorkspaceContext();
  const settings = getSettingsContext();
  const agentContext = getAgentContext();
  const av = session.artifactViewer;

  // The guide tab's data layer. This host renders its own chrome (header +
  // regenerate), so it drives the loader directly rather than through a child.
  const guideLoader = new GuideLoader({
    getCtx: () => session.ctx,
    getKey: () => guideKey,
    getScope: () => "branch",
    getAgent: () => resolveReviewAgent(settings, agentContext),
  });
  $effect(() => {
    void guideKey;
    void guideLoader.load(false);
  });

  // The active content tab lives in the pane store so chrome outside this
  // component can react to it (see PaneViewStore.prReviewTab).
  type ContentTab = "activity" | "guide" | "diff";
  const sub = $derived(av.prReviewTab);

  const chatSession = $derived(session.sessionFor(chatTabId));
  const diffScope = $derived<DiffScope>({ kind: "pr", baseSha: pr.baseSha });

  // Existing GitHub inline review comments. Fetched once here and shared with
  // both the Diff tab (read-only, anchored at their line) and the Activity tab
  // (which owns reply / resolve, mutating these objects in place) — so the
  // heaviest read isn't duplicated across the two surfaces.
  let reviewThreads = $state<ReviewThread[]>([]);
  function loadThreads() {
    const number = pr.number;
    void window.solus
      .prListThreads(session.ctx, number)
      .then((t) => {
        if (pr.number === number) reviewThreads = t;
      })
      .catch(() => {});
  }
  $effect(() => {
    void pr.number;
    loadThreads();
  });

  // Reply / resolve for the threads rendered inline in the Diff tab. Mirrors the
  // Activity tab's affordances; mutation of the thread object lives in
  // DiffThreadComment so the inline card and the popover update in place.
  function replyToThread(threadId: string, body: string) {
    return window.solus.prReplyThread(session.ctx, pr.number, threadId, body);
  }

  async function resolveThread(threadId: string, resolved: boolean): Promise<void> {
    if (resolved) {
      await window.solus.prResolveThread(session.ctx, pr.number, threadId);
    } else {
      await window.solus.prUnresolveThread(session.ctx, pr.number, threadId);
    }
  }

  let drafts = $state<ReviewDraftComment[]>([]);
  let loadedDraftKey = $state<string | null>(null);

  $effect(() => {
    void guideKey;
    void loadDrafts();
  });

  async function loadDrafts(): Promise<void> {
    const key = guideKey;
    if (key === loadedDraftKey) return;
    loadedDraftKey = key;
    const state = await window.solus.readReviewState(session.ctx, key);
    if (guideKey !== key) return;
    drafts = state?.drafts ?? [];
  }

  function persistDrafts(): Promise<boolean> {
    const state: ReviewState = {
      version: 1,
      key: guideKey,
      drafts: drafts.map((draft) => ({
        id: draft.id,
        path: draft.path,
        startLine: draft.startLine,
        line: draft.line,
        side: draft.side,
        body: draft.body,
        createdAt: draft.createdAt,
      })),
    };
    return window.solus.writeReviewState(session.ctx, state);
  }

  function upsertDraft(input: Omit<ReviewDraftComment, "id" | "createdAt">): void {
    const anchor = `${input.path}::${input.side}::${input.line}`;
    const existing = drafts.find((d) => `${d.path}::${d.side}::${d.line}` === anchor);
    if (existing) {
      existing.body = input.body;
      existing.startLine = input.startLine;
    } else {
      drafts.push({ id: crypto.randomUUID(), createdAt: Date.now(), ...input });
    }
    void persistDrafts();
  }

  function updateDraftBody(id: string, body: string): void {
    const draft = drafts.find((d) => d.id === id);
    if (!draft) return;
    draft.body = body;
    void persistDrafts();
  }

  function removeDraft(id: string): void {
    const index = drafts.findIndex((d) => d.id === id);
    if (index === -1) return;
    drafts.splice(index, 1);
    void persistDrafts();
  }

  function clearDrafts(): void {
    if (drafts.length === 0) return;
    drafts.splice(0, drafts.length);
    void persistDrafts();
  }

  function draftToDiffComment(draft: ReviewDraftComment): DiffComment {
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

  const diffComments = $derived(drafts.map(draftToDiffComment));

  function saveDiffComment(comment: ReviewDiffCommentSave): void {
    if (comment.id) {
      updateDraftBody(comment.id, comment.comment);
      return;
    }
    upsertDraft({
      path: comment.filePath,
      line: comment.endLine,
      startLine: comment.startLine !== comment.endLine ? comment.startLine : undefined,
      side: comment.side,
      body: comment.comment,
    });
  }

  let showSubmit = $state(false);

  // Keep each visited tab mounted (DiffState / scroll / derived chains survive
  // toggles) and hide the inactive ones via display:none, per the Svelte perf rule.
  // Mount whichever tab we open on (Activity by default) so it renders without a
  // blank frame; the others mount lazily on first visit.
  let mountedGuide = $state(untrack(() => sub === "guide"));
  let mountedDiff = $state(untrack(() => sub === "diff"));
  let mountedActivity = $state(untrack(() => sub === "activity"));
  $effect(() => {
    if (sub === "guide") mountedGuide = true;
    else if (sub === "diff") mountedDiff = true;
    else if (sub === "activity") mountedActivity = true;
  });

  const TABS: { id: ContentTab; label: string }[] = [
    { id: "activity", label: "Activity" },
    { id: "guide", label: "Guide" },
    { id: "diff", label: "Diff" },
  ];

  function select(next: ContentTab) {
    av.prReviewTab = next;
    requestInputFocus();
  }

  // File chips in the Guide / threads in Activity jump to the Diff tab rather
  // than spawning a separate diff pane (which would clobber this surface).
  function jumpToDiff() {
    av.prReviewTab = "diff";
    mountedDiff = true;
    requestInputFocus();
  }

  // Pop the chat out from behind / back under the maximized review. Make sure the
  // chat conversation is the active primary tab when it becomes visible.
  function toggleChat() {
    if (av.maximized) session.selectTab(chatTabId);
    onToggleSecondaryMaximize?.();
    requestInputFocus();
  }

  function exit() {
    session.exitPrReview(chatTabId);
    requestInputFocus();
  }

  const prUrl = $derived(`https://${pr.host}/${pr.owner}/${pr.repo}/pull/${pr.number}`);

  function openPr() {
    void window.solus.openExternal(prUrl);
  }

  // Esc closes the PR review panel. Skip when a comment/text field is focused
  // (it cancels its own edit) or the submit modal is open (it owns Esc).
  function onWindowKeydown(e: KeyboardEvent) {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (showSubmit) return;
    const el = e.target as HTMLElement | null;
    if (el && (el.isContentEditable || el.closest("input, textarea"))) return;
    e.preventDefault();
    exit();
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<section class="flex h-full min-h-0 flex-col bg-(--solus-container-bg)">
  <header
    class="flex h-[var(--solus-chrome-row-h,2.9375rem)] shrink-0 items-center gap-2 border-b border-[color:var(--solus-chrome-row-border,color-mix(in_srgb,var(--solus-container-border)_50%,transparent))] pr-2 pl-3"
  >
    <div
      class="inline-flex items-center gap-0.5 rounded-lg bg-(--solus-accent-light) p-0.5"
      role="tablist"
      aria-label="PR review tabs"
    >
      {#each TABS as t (t.id)}
        <button
          type="button"
          role="tab"
          aria-selected={sub === t.id}
          class={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${sub === t.id ? "bg-(--solus-container-bg) text-(--solus-text-primary) shadow-sm" : "text-(--solus-text-tertiary) hover:text-(--solus-text-secondary)"}`}
          onclick={() => select(t.id)}
        >
          {t.label}
        </button>
      {/each}
    </div>

    <div class="flex min-w-0 flex-1 items-center text-xs text-(--solus-text-tertiary)">
      <button
        type="button"
        class="inline-flex shrink-0 items-center gap-1 rounded font-semibold text-(--solus-text-secondary) transition-colors hover:text-(--solus-accent)"
        onclick={openPr}
        use:tooltip={"Open PR on " + pr.host}
      >
        #{pr.number}
        <ArrowSquareOutIcon size={12} weight="bold" />
      </button>
      <span class="px-1">·</span>
      <span class="truncate">{pr.title}</span>
    </div>

    <button
      type="button"
      class={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${av.maximized ? "text-(--solus-text-tertiary) hover:bg-(--solus-accent-light) hover:text-(--solus-text-primary)" : "bg-(--solus-accent-soft) text-(--solus-accent)"}`}
      onclick={toggleChat}
      use:tooltip={av.maximized ? "Show chat alongside the review" : "Hide chat, focus the review"}
    >
      <ChatCircleIcon size={14} weight="bold" />
      Chat
    </button>

    {#if sub === "guide"}
      <button
        type="button"
        class="flex size-7 items-center justify-center rounded-md text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-accent-light) hover:text-(--solus-text-primary)"
        aria-label="Regenerate review guide"
        use:tooltip={"Regenerate review"}
        onclick={() => guideLoader.refresh()}
      >
        <ArrowsClockwiseIcon size={15} />
      </button>
    {/if}

    <button
      type="button"
      class="flex size-7 items-center justify-center rounded-md text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-accent-light) hover:text-(--solus-text-primary)"
      aria-label="Exit PR review"
      onclick={exit}
    >
      <XIcon size={15} />
    </button>
  </header>

  <div class="relative min-h-0 flex-1">
    {#if mountedGuide}
      <div
        class="absolute inset-0 flex flex-col border-l border-(--solus-container-border)"
        class:hidden={sub !== "guide"}
      >
        <GuideSurface
          loader={guideLoader}
          onFileJump={jumpToDiff}
          comments={diffComments}
          onCommentSave={saveDiffComment}
          onCommentDelete={removeDraft}
          meta={{ repo: pr.repo, number: pr.number, baseRef: pr.baseRef, branch: pr.branch }}
        />
      </div>
    {/if}
    {#if mountedDiff}
      <div class="absolute inset-0" class:hidden={sub !== "diff"}>
        <DiffPanel
          tabId={chatTabId}
          projectPath={chatSession?.workingDirectory ?? pr.worktreePath}
          worktreePath={pr.worktreePath}
          worktreeBranch={pr.branch}
          targetBranch={pr.baseRef}
          isWorktree
          onClose={() => select("guide")}
          maximized={av.maximized}
          onToggleMaximize={onToggleSecondaryMaximize}
          initialScope={diffScope}
          externalComments={diffComments}
          onExternalCommentSave={saveDiffComment}
          onExternalCommentDelete={removeDraft}
          {reviewThreads}
          onThreadReply={replyToThread}
          onThreadResolve={resolveThread}
        />
      </div>
    {/if}
    {#if mountedActivity}
      <div class="absolute inset-0" class:hidden={sub !== "activity"}>
        <ActivityFeed
          {pr}
          threads={reviewThreads}
          onRefreshThreads={loadThreads}
          onJump={() => jumpToDiff()}
        />
      </div>
    {/if}
  </div>

  {#if drafts.length > 0}
    <PendingReviewTray
      {drafts}
      onSubmit={() => (showSubmit = true)}
      onRemove={removeDraft}
      onJump={() => jumpToDiff()}
    />
  {/if}
</section>

{#if showSubmit}
  <SubmitReviewModal
    {pr}
    {drafts}
    onClose={() => (showSubmit = false)}
    onSubmitted={clearDrafts}
  />
{/if}
