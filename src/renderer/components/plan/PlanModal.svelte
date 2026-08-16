<script lang="ts">
  import "./PlanModal.css";

  import type { Editor } from "@tiptap/core";
  import {
    CheckIcon,
    CopyIcon,
    BookmarkSimpleIcon,
    CaretDownIcon,
    CheckCircleIcon,
    XCircleIcon,
    ArrowUpRightIcon,
    ArrowSquareOutIcon,
    DotsThreeIcon,
  } from "phosphor-svelte";
  import { runtime, getWorkspaceContext, getPlanStore } from "../../contexts";
  import PlanActionBar from "./PlanActionBar.svelte";
  import DocumentShell from "../document-shell/DocumentShell.svelte";
  import CommentLayer from "../comments/CommentLayer.svelte";
  import { CommentMark } from "../editor/commentMark";
  import type { Plan, PlanComment, PlanCommentReply } from "../../../shared/types";
  import { useKeybinding } from "../../lib/keybindings/use-keybinding.svelte";
  import Kbd from "../ui/Kbd.svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";

  const commentExtensions = [CommentMark];

  interface Props {
    plan: Plan;
    inline?: boolean;
    minimizeOutline?: boolean;
    onClose?: () => void;
  }

  let { plan, inline = false, minimizeOutline = false, onClose }: Props = $props();

  const session = getWorkspaceContext();
  const planStore = getPlanStore();
  const isMobile = $derived(runtime.isMobileViewport);
  const comments = $derived(plan.comments);
  const isBookmarked = $derived(plan.bookmarked);
  const isPreview = $derived(!!planStore.previewDescriptor);
  const sourceSessionAvailable = $derived(
    planStore.previewDescriptor?.sessionAvailable !== false,
  );

  const planRevisions = $derived(planStore.plansForSession(plan.sessionId));
  const revisionCount = $derived(planRevisions.length);
  const currentRevisionIndex = $derived(
    planRevisions.findIndex((p) => p.id === plan.id),
  );
  let revisionDropdownOpen = $state(false);

  // Overflow (⋯) menu holding the secondary header actions (Copy, Bookmark).
  let overflowOpen = $state(false);

  // Editor handles owned by the shell, surfaced here to drive comment features.
  let shell: DocumentShell | null = $state(null);
  let tiptapEditor: Editor | null = $state(null);
  let scrollContainer: HTMLDivElement | null = $state(null);
  let suppressSave = $state(false);

  // Comments. The layer itself is shared with the document editor — this
  // surface only says where the threads are persisted and what the margin's
  // footer holds.
  let commentLayer: CommentLayer | null = $state(null);
  let canComment = $state(false);
  let commentsRailOpen = $state(false);
  let composerCollapsed = $state(false);
  let commentsRailPlanId = $state<string | null>(null);

  // Document position of each thread's mark, for the outline's section counts.
  let threadAnchors = $state<{ id: string; pos: number }[]>([]);

  $effect(() => {
    const previousPlanId = commentsRailPlanId;
    if (previousPlanId === plan.id) return;
    commentsRailPlanId = plan.id;
    if (previousPlanId === null) return;
    commentsRailOpen = comments.length > 0;
  });

  async function handleToggleBookmark() {
    await planStore.toggleBookmark(plan.id);
  }

  function closeModal() {
    // When a pane hosts this shell it owns the close policy (including the
    // preview cases); pill mode has no pane, so resolve the dismissal here.
    if (onClose) onClose();
    else if (isPreview) session.closePlanPreview();
    else session.closePlanModal();
  }

  useKeybinding("plan-modal.toggle-bookmark", () => handleToggleBookmark());
  useKeybinding("plan-modal.toggle-comments", () => {
    commentsRailOpen = !commentsRailOpen;
  });
  useKeybinding(
    "plan-modal.resume",
    () => {
      if (isPreview) {
        const d = planStore.previewDescriptor;
        if (d) session.resumeSessionFromDescriptor(d);
      }
    },
    { enabled: () => isPreview },
  );
  useKeybinding("plan-modal.new-tab", () => {
    session.openSessionDraft({ via: "click" });
  });

  function handleSave(md: string) {
    planStore.updateContent(plan.id, md);
    return planStore.flushContentSave(plan.id);
  }

  // Comment persistence. Everything else about the margin — the selection
  // rules, the form, the marks, the thread cards — is CommentLayer's.
  function addComment(comment: PlanComment) {
    planStore.addComment(plan.id, comment);
  }
  function editComment(commentId: string, text: string) {
    planStore.updateComment(plan.id, commentId, text);
  }
  function deleteComment(commentId: string) {
    planStore.removeComment(plan.id, commentId);
  }
  function replyToComment(commentId: string, reply: PlanCommentReply) {
    planStore.addReply(plan.id, commentId, reply);
  }
  function resolveComment(commentId: string, resolved: boolean) {
    planStore.setCommentResolved(plan.id, commentId, resolved ? "you" : null);
  }
  function readComment(commentId: string) {
    planStore.markCommentRead(plan.id, commentId);
  }

</script>

<DocumentShell
  bind:this={shell}
  title="Review Plan"
  content={plan.content}
  {inline}
  {minimizeOutline}
  editorClass="plan-document-editor"
  rootClass="plan-shell"
  scope="plan-modal"
  bindings={{ close: "plan-modal.close", save: "plan-modal.save", copy: "plan-modal.copy", googleUpload: "plan-modal.google-upload", find: "plan-modal.find", pinOutline: "plan-modal.pin-outline" }}
  extraExtensions={commentExtensions}
  onSave={handleSave}
  onClose={closeModal}
  onCommentSelection={() => commentLayer?.startComment()}
  canCommentSelection={canComment}
  {threadAnchors}
  railWidth="clamp(13.5rem, 26cqi, 18rem)"
  bind:tiptapEditor
  bind:scrollContainer
  bind:suppressSave
  rootTestId="plan-modal"
  closeTestId="plan-modal-close"
  scrollAriaLabel="Plan document"
  placeholder="Start writing…"
>
  {#snippet documentMeta()}
    {#if revisionCount > 1}
      <DropdownMenu.Root bind:open={revisionDropdownOpen}>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              class="group inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-lg border-0 px-2 text-[0.8125rem] font-normal transition-[background-color,color,scale] duration-(--duration-quick) ease-(--ease-premium) active:scale-[0.96] focus-visible:outline-none {revisionDropdownOpen
 ? 'bg-(--solus-surface-hover) text-(--solus-text-primary)'
 : 'bg-transparent text-(--solus-text-tertiary) hover:bg-[color-mix(in_srgb,var(--solus-surface-hover)_60%,transparent)] hover:text-(--solus-text-secondary) focus-visible:bg-(--solus-surface-hover) focus-visible:text-(--solus-text-secondary)'}"
            >
              <span class="tabular-nums">v{currentRevisionIndex + 1} of {revisionCount}</span>
              <CaretDownIcon
                size={10}
                class="shrink-0 opacity-60 transition-transform duration-(--duration-quick) ease-(--ease-premium) group-aria-expanded:rotate-180"
              />
            </button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="bottom" align="start" sideOffset={6} collisionPadding={8} class="w-[14rem]">
          <DropdownMenu.Label>Plan revisions</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={plan.id}>
            {#each planRevisions as rev, i (rev.id)}
              <DropdownMenu.RadioItem value={rev.id} onSelect={() => session.openPlanModal(rev.id)}>
                <span class="shrink-0 font-medium tabular-nums">v{i + 1}</span>
                <span class="min-w-0 flex-1 truncate text-menu-meta text-(--solus-text-tertiary)">
                  {new Date(rev.timestamp).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                {#if rev.status === "accepted"}
                  <CheckCircleIcon size={11} weight="fill" class="text-(--solus-status-complete)" />
                {:else if rev.status === "rejected"}
                  <XCircleIcon size={11} weight="fill" class="text-(--solus-text-tertiary)" />
                {/if}
              </DropdownMenu.RadioItem>
            {/each}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/if}
  {/snippet}

  {#snippet documentActions({ copied, copy, googleUpload, uploading, uploaded })}
    <button
      type="button"
      onclick={() => (commentsRailOpen = !commentsRailOpen)}
      class="plan-soft-pill"
      class:plan-soft-pill--active={commentsRailOpen}
      title={commentsRailOpen ? "Hide comments (⌥M)" : "Show comments (⌥M)"}
      aria-label={commentsRailOpen ? "Hide comments" : "Show comments"}
    >
      <span class="plan-soft-pill__swatch" aria-hidden="true"></span>
      <span class="plan-soft-pill__label">Comments{comments.length > 0 ? ` (${comments.length})` : ""}</span>
    </button>
    <button
      type="button"
      onclick={handleToggleBookmark}
      class="plan-soft-pill plan-soft-pill--icon"
      class:plan-soft-pill--active={isBookmarked}
      title={isBookmarked ? "Bookmarked (⌥B)" : "Bookmark (⌥B)"}
      aria-label={isBookmarked ? "Bookmarked" : "Bookmark"}
    >
      <BookmarkSimpleIcon size={14} weight={isBookmarked ? "fill" : "regular"} class={isBookmarked ? "text-(--solus-accent)" : ""} />
    </button>
    <!-- Secondary actions (open session, Google Docs, copy) collapse into one overflow menu. -->
    <DropdownMenu.Root bind:open={overflowOpen}>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <button {...props} type="button" class="plan-soft-pill plan-soft-pill--icon" class:plan-soft-pill--active={overflowOpen} data-testid="work-actions-menu" title="More actions" aria-label="More actions">
            <DotsThreeIcon size={16} weight="bold" />
          </button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content side="bottom" align="end" sideOffset={6} collisionPadding={8} class="w-auto min-w-56 whitespace-nowrap">
        <DropdownMenu.Label>Plan actions</DropdownMenu.Label>
        {#if isPreview}
          <DropdownMenu.Item onSelect={() => { const d = planStore.previewDescriptor; if (d) session.resumeSessionFromDescriptor(d); }}>
            {#if sourceSessionAvailable}<ArrowUpRightIcon size={14} />{:else}<XCircleIcon size={14} class="text-(--solus-status-error)" />{/if}
            <span class="flex-1 text-left">{sourceSessionAvailable ? "Open session" : "Session no longer available"}</span>{#if !isMobile}<span class="ml-auto"><Kbd variant="inline">⌥O</Kbd></span>{/if}
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
        {/if}
        {#if googleUpload}
          <!-- Keep the menu open so the upload state stays visible. -->
          <DropdownMenu.Item data-testid="google-upload" disabled={uploading} closeOnSelect={false} onSelect={() => googleUpload?.()}>
            {#if uploaded}
              <CheckIcon size={14} /><span class="flex-1 text-left">Opened!</span>
            {:else}
              <ArrowSquareOutIcon size={14} /><span class="flex-1 text-left">{uploading ? "Uploading…" : "Open in Google Docs"}</span>
            {/if}
            {#if !isMobile}<span class="ml-auto"><Kbd variant="inline">⌥G</Kbd></span>{/if}
          </DropdownMenu.Item>
        {/if}
        {#if googleUpload}
          <DropdownMenu.Separator />
        {/if}
        <DropdownMenu.Item onSelect={copy}>
          {#if copied}<CheckIcon size={14} /><span class="flex-1 text-left">Copied!</span>{:else}<CopyIcon size={14} /><span class="flex-1 text-left">Copy plan</span>{/if}
          {#if !isMobile}<span class="ml-auto"><Kbd variant="inline">⌥C</Kbd></span>{/if}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/snippet}

  {#snippet rail({ folded })}
    <CommentLayer
      bind:this={commentLayer}
      editor={tiptapEditor}
      railFolded={folded}
      {scrollContainer}
      {comments}
      onAdd={addComment}
      onEdit={editComment}
      onDelete={deleteComment}
      onReply={replyToComment}
      onResolve={resolveComment}
      onRead={readComment}
      startCommentBinding="plan-modal.start-comment"
      flushSave={() => shell?.flushSave() ?? Promise.resolve()}
      bind:suppressSave
      bind:canComment
      bind:railOpen={commentsRailOpen}
      bind:threadAnchors
    />
  {/snippet}

  {#snippet footer()}
    <div
      class="plan-action-bar-sleeve shrink-0 px-5 pt-2 pb-3 max-md:px-3 max-md:pb-2"
      class:absolute={composerCollapsed}
      class:inset-x-0={composerCollapsed}
      class:bottom-3={composerCollapsed}
      class:z-20={composerCollapsed}
      class:pointer-events-none={composerCollapsed}
      style:padding={composerCollapsed ? "0" : undefined}
    >
      <PlanActionBar
        planId={plan.id}
        inlineCommentCount={comments.length}
        compact={isMobile}
        forceShowWorktreeToggle={isPreview}
        bind:collapsed={composerCollapsed}
        onDone={closeModal}
      />
    </div>
  {/snippet}

</DocumentShell>
