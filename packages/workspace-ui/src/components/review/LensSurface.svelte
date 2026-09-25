<script lang="ts">
  import { untrack } from "svelte";
  import {
    History as RestoreIcon,
    MessageSquarePlus as CommentIcon,
    RefreshCw as RegenerateIcon,
    Plus as NewLensIcon,
    BookmarkPlus as SaveWorkIcon,
    Save as SavePromptIcon,
  } from "@lucide/svelte";
  import type { ReviewLensComment, ReviewLensSource } from "@solus/contracts/review";
  import { getSettingsContext, getWorkspaceContext } from "../../contexts";
  import { resolveReviewAgent } from "../../lib/reviewAgent";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import { threadTime } from "../../lib/relative-time";
  import { Button } from "../ui/button";
  import { CommentComposer } from "../ui/comment-composer";
  import SandboxFrame from "../artifact/SandboxFrame.svelte";
  import LensStart from "./LensStart.svelte";
  import LensCommentLayer from "./LensCommentLayer.svelte";
  import { reviewLensStore, type LensSubject } from "./review-lens.store.svelte";
  import {
    draftLineRefusal,
    framePointForPin,
    isLensRunning,
    lensJobLabel,
    queryLensAnchor,
    savedLensFromPrompt,
    type LensPullRequestAdapter,
  } from "./lib/lens-surface";

  /**
   * The Lens view of a change (docs/plans/review-lenses.md): one generated HTML
   * artifact for this review target, made from the user's prompt. The host owns
   * the job and the record; this surface reads them from the lens store and
   * sends the user's commands back.
   */
  let {
    subject,
    active,
    sourceTabId,
    pullRequest,
  }: {
    /** Null while the checkout is still unknown. */
    subject: LensSubject | null;
    /** The Lens view is the one showing. */
    active: boolean;
    /** The conversation "Save as work" files the work against. */
    sourceTabId?: string;
    /** Present on a pull-request review: comments can reach the pull request. */
    pullRequest?: LensPullRequestAdapter;
  } = $props();

  const settings = getSettingsContext();
  const session = getWorkspaceContext();

  const entry = $derived(reviewLensStore.entryFor(subject));
  const snapshot = $derived(entry?.snapshot ?? null);
  const current = $derived(snapshot?.current ?? null);
  const job = $derived(snapshot?.job ?? null);
  const running = $derived(isLensRunning(job));
  const reconnecting = $derived(subject ? reviewLensStore.reconnectingFor(subject.serverId) : false);
  const openComments = $derived(current?.comments.filter((comment) => !comment.resolvedAt) ?? []);

  let showStart = $state(false);
  let armed = $state(false);
  let draftPin = $state<{ x: number; y: number } | null>(null);
  let openCommentId = $state<string | null>(null);
  let busy = $state(false);
  let applyComments = $state(true);
  let editKey = $state(0);
  let now = $state(Date.now());
  let frameWrapEl = $state<HTMLDivElement | null>(null);
  let dismissedFailureAt = $state(0);

  // Read the lens again each time the view opens, so "Outdated" follows edits
  // made while it was hidden. Never generate on open: a lens is manual in v1,
  // and the empty state is a real offer.
  $effect(() => {
    const next = subject;
    if (!next || !active) return;
    void untrack(() => reviewLensStore.load(next));
  });

  // Looking at the tab is what reads a new lens.
  $effect(() => {
    if (!active || !snapshot) return;
    void snapshot.revision;
    untrack(() => reviewLensStore.markSeen(subject));
    now = Date.now();
  });

  const failure = $derived(
    job?.status === "failed" && job.updatedAt > dismissedFailureAt ? job : null,
  );

  async function command(label: string, action: (target: LensSubject) => Promise<void>, refocus = true) {
    const target = subject;
    if (!target || busy) return;
    busy = true;
    try {
      await action(target);
    } catch (error) {
      toasts.error(`Couldn't ${label}`, { description: error instanceof Error ? error.message : String(error) });
    } finally {
      busy = false;
      if (refocus) requestInputFocus();
    }
  }

  function generate(source: ReviewLensSource) {
    showStart = false;
    void command("make the lens", (target) => reviewLensStore.generate(target, { ...resolveReviewAgent(settings), source }));
  }

  function regenerate() {
    if (current) generate(current.lens.source);
  }

  function sendEdit(prompt: string) {
    const commentIds = applyComments ? openComments.map((comment) => comment.id) : [];
    if (!prompt.trim() && commentIds.length === 0) return;
    editKey++;
    void command(
      "edit the lens",
      (target) => reviewLensStore.edit(target, { ...resolveReviewAgent(settings), prompt, commentIds }),
      false,
    );
  }

  function savePrompt(prompt: string) {
    if (!prompt.trim()) return;
    const lens = savedLensFromPrompt(prompt);
    settings.update({ savedLenses: [...settings.savedLenses, lens] });
    toasts.success(`Saved “${lens.name}” as a lens`);
  }

  async function saveAsWork() {
    if (!current) return;
    const saved = await session.createArtifact(current.lens.html, sourceTabId, current.lens.title);
    if (saved) {
      toasts.success(`Saved “${saved.title}” as a work`, {
        action: { label: "Open", onAction: () => session.openWork(saved.workId) },
      });
    }
    requestInputFocus();
  }

  async function addComment(pin: { x: number; y: number }, label: string, body: string) {
    const frame = frameWrapEl?.querySelector("iframe");
    const layer = frameWrapEl?.getBoundingClientRect();
    const anchor = frame && layer
      ? await queryLensAnchor(frame, framePointForPin(pin, layer, frame.getBoundingClientRect()))
      : {};
    await command(
      "add the comment",
      (target) => reviewLensStore.changeComments(target, { kind: "add", comment: { pin, label, body, ...anchor } }),
      false,
    );
  }

  function changeComment(label: string, change: Parameters<typeof reviewLensStore.changeComments>[1]) {
    void command(label, (target) => reviewLensStore.changeComments(target, change), false);
  }

  function addDraft(commentId: string) {
    const comment = current?.comments.find((item) => item.id === commentId);
    const adapter = pullRequest;
    if (!comment?.codeAnchor || !adapter || busy) return;
    const refusal = draftLineRefusal(comment.codeAnchor, adapter.patch, adapter.drafts);
    if (refusal) {
      toasts.error("Couldn't add the draft", { description: refusal });
      return;
    }
    const draftId = adapter.addDraft(comment.codeAnchor, comment.body);
    if (!draftId) return;
    void command("add the draft", async (target) => {
      try {
        await reviewLensStore.changeComments(target, { kind: "mark-drafted", commentId, draftId });
      } catch (error) {
        // The draft and the lens comment move together, or not at all.
        adapter.removeDraft(draftId);
        throw error;
      }
    }, false);
  }

  function removeDraft(commentId: string) {
    const posted = current?.comments.find((item) => item.id === commentId)?.posted;
    if (posted?.kind !== "draft-line" || !pullRequest) return;
    pullRequest.removeDraft(posted.draftId);
    changeComment("remove the draft", { kind: "mark-drafted", commentId, draftId: null });
  }

  const pullRequestComments = $derived(
    pullRequest
      ? {
          canPost: pullRequest.canComment && !reconnecting,
          postReason: reconnecting ? "Reconnecting to the host…" : pullRequest.commentReason,
          draftRefusal: (comment: ReviewLensComment) =>
            draftLineRefusal(comment.codeAnchor, pullRequest.patch, pullRequest.drafts),
          hasDraft: (draftId: string) => pullRequest.drafts.some((draft) => draft.id === draftId),
          diffReady: pullRequest.patch !== null,
        }
      : undefined,
  );
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="lens-surface">
  {#if !subject}
    <p class="m-auto px-6 text-center text-workspace-chrome text-(--solus-text-tertiary)">
      This review has no checkout to read yet.
    </p>
  {:else if !snapshot && entry?.error}
    <div class="m-auto flex flex-col items-center gap-2 px-6 text-center text-workspace-chrome" role="alert">
      <p class="text-destructive">Couldn't read the lens: {entry.error}</p>
      <Button size="xs" variant="outline" onclick={() => void command("read the lens", (target) => reviewLensStore.load(target))}>Try again</Button>
    </div>
  {:else if !snapshot && entry?.loaded}
    <p class="m-auto px-6 text-center text-workspace-chrome text-(--solus-text-tertiary)">
      Lenses are not available for this review: the host has no checkout for it.
    </p>
  {:else if !snapshot}
    <p class="m-auto text-workspace-chrome text-(--solus-text-tertiary)" aria-live="polite">Loading the lens…</p>
  {:else}
    {#if failure}
      <div
        class="mx-4 mt-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-workspace-chrome"
        role="alert"
      >
        <span class="min-w-0 flex-1 text-destructive">
          {failure.kind === "edit" ? "The edit failed" : "The lens failed"}: {failure.error ?? "Unknown error"}
          {#if current}The lens below did not change.{/if}
        </span>
        <Button variant="ghost" size="xs" onclick={() => (dismissedFailureAt = failure.updatedAt)}>Dismiss</Button>
      </div>
    {/if}

    {#if !current || showStart}
      {#if running && !current && job}
        <div class="m-auto flex flex-col items-center gap-3 px-6 text-center text-workspace-chrome" aria-live="polite">
          <p class="text-(--solus-text-secondary)">{lensJobLabel(job)}…</p>
          <Button variant="outline" size="xs" onclick={() => void command("cancel", (target) => reviewLensStore.cancel(target))}>
            Cancel
          </Button>
        </div>
      {:else}
        <div class="min-h-0 flex-1 overflow-y-auto">
          <LensStart
            savedLenses={settings.savedLenses}
            replacesTitle={showStart ? (current?.lens.title ?? null) : null}
            disabled={running || reconnecting || busy}
            disabledReason={running ? "A lens is already running" : "Reconnecting to the host…"}
            onGenerate={generate}
            onSavePrompt={savePrompt}
            onCancel={showStart && current ? () => (showStart = false) : undefined}
          />
        </div>
      {/if}
    {:else}
      <header class="flex shrink-0 flex-col gap-1.5 border-b border-(--solus-container-border) px-4 py-2.5 text-workspace-chrome">
        <div class="flex min-w-0 items-center gap-2">
          <h2 class="min-w-0 truncate font-medium text-foreground" title={current.lens.title}>{current.lens.title}</h2>
          {#if snapshot.outdated}
            <span
              class="shrink-0 rounded-md bg-(--wash-2) px-1.5 py-0.5 text-xs text-(--solus-text-secondary)"
              title="The change moved after this lens was made"
            >
              Outdated
            </span>
          {/if}
          <span class="min-w-0 flex-1"></span>
          <span class="shrink-0 truncate text-xs text-(--solus-text-tertiary) tabular-nums @max-[30rem]/pane:hidden">
            {current.lens.source.name} · {threadTime(Date.parse(current.lens.generatedAt), now)} · {current.lens.headSha.slice(0, 7)}
          </span>
        </div>
        <details class="text-xs text-(--solus-text-tertiary)">
          <summary class="cursor-pointer select-none">Prompt{current.lens.edits.length ? ` and ${current.lens.edits.length} edit${current.lens.edits.length === 1 ? "" : "s"}` : ""}</summary>
          <p class="mt-1 whitespace-pre-wrap">{current.lens.source.prompt}</p>
          {#each current.lens.edits as edit, index (index)}
            <p class="mt-1 whitespace-pre-wrap">Edit {index + 1}: {edit.prompt}</p>
          {/each}
        </details>
        <div class="flex flex-wrap items-center gap-1">
          {#if running && job}
            <span class="mr-1 text-xs text-(--solus-text-secondary)" aria-live="polite">{lensJobLabel(job)}…</span>
            <Button variant="outline" size="xs" onclick={() => void command("cancel", (target) => reviewLensStore.cancel(target))}>
              Cancel
            </Button>
          {:else}
            <Button variant="ghost" size="xs" disabled={busy || reconnecting} onclick={regenerate} title="Make this lens again for the current change">
              <RegenerateIcon aria-hidden="true" />Regenerate
            </Button>
            <Button variant="ghost" size="xs" disabled={busy || reconnecting} onclick={() => (showStart = true)} title="Replace this lens with a different one">
              <NewLensIcon aria-hidden="true" />New lens
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={busy || reconnecting || !snapshot.hasPrevious}
              title={snapshot.hasPrevious ? "Swap this lens with the previous version" : "There is no previous version"}
              onclick={() => void command("restore the lens", (target) => reviewLensStore.restore(target))}
            >
              <RestoreIcon aria-hidden="true" />Restore previous
            </Button>
          {/if}
          <Button
            variant={armed ? "secondary" : "ghost"}
            size="xs"
            aria-pressed={armed}
            disabled={reconnecting}
            title="Click the lens to pin a comment"
            onclick={() => {
              armed = !armed;
              draftPin = null;
            }}
          >
            <CommentIcon aria-hidden="true" />Comment
          </Button>
          <span class="flex-1"></span>
          <Button variant="ghost" size="xs" onclick={() => void saveAsWork()} title="Copy this lens into Folio as an artifact work">
            <SaveWorkIcon aria-hidden="true" />Save as work
          </Button>
          {#if !current.lens.source.savedLensId}
            <Button variant="ghost" size="xs" onclick={() => savePrompt(current.lens.source.prompt)} title="Keep this prompt in Settings → Review">
              <SavePromptIcon aria-hidden="true" />Save as lens
            </Button>
          {/if}
        </div>
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="relative" bind:this={frameWrapEl}>
          <SandboxFrame html={current.lens.html} isolated lazy={false} expandable={false} />
          <LensCommentLayer
            comments={current.comments}
            bind:armed
            bind:draftPin
            bind:openCommentId
            pullRequest={pullRequestComments}
            busy={busy || reconnecting}
            onAdd={(pin, label, body) => void addComment(pin, label, body)}
            onEdit={(commentId, body) => changeComment("edit the comment", { kind: "edit", commentId, body })}
            onResolve={(commentId, resolved) => changeComment("resolve the comment", { kind: "resolve", commentId, resolved })}
            onDelete={(commentId) => changeComment("delete the comment", { kind: "delete", commentId })}
            onPost={(commentId) => void command("post the comment", (target) => reviewLensStore.postComment(target, commentId), false)}
            onRetract={(commentId) => void command("retract the comment", (target) => reviewLensStore.retractComment(target, commentId), false)}
            onAddDraft={addDraft}
            onRemoveDraft={removeDraft}
          />
        </div>
      </div>

      <div class="shrink-0 border-t border-(--solus-container-border) px-4 py-2.5">
        {#key editKey}
          <CommentComposer
            surface="compact"
            placeholder={running ? "Wait for the lens to finish…" : "Ask for a change to the lens…"}
            ariaLabel="Lens edit"
            submitLabel="Send"
            submitOn="enter"
            cancelLabel="Clear"
            autoFocus={active && editKey > 0}
            disabled={running || busy || reconnecting}
            onSave={sendEdit}
            onCancel={() => editKey++}
          >
            {#snippet secondaryActions()}
              {#if openComments.length > 0}
                <label class="flex items-center gap-1.5 text-xs text-(--solus-text-secondary)">
                  <input type="checkbox" bind:checked={applyComments} class="accent-(--solus-accent)" />
                  Apply {openComments.length} comment{openComments.length === 1 ? "" : "s"}
                </label>
              {/if}
            {/snippet}
          </CommentComposer>
        {/key}
        {#if openComments.length > 0 && applyComments}
          <Button
            variant="ghost"
            size="xs"
            class="mt-1"
            disabled={running || busy || reconnecting}
            onclick={() => sendEdit("")}
          >
            Apply {openComments.length} comment{openComments.length === 1 ? "" : "s"} now
          </Button>
        {/if}
      </div>
    {/if}
  {/if}
</div>
