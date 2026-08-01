<script lang="ts">
  import type { Editor } from "@tiptap/core";
  import { ArrowUpIcon } from "phosphor-svelte";
  import * as TooltipUI from "@renderer/components/ui/tooltip";
  import { Button } from "../ui/button";
  import DocumentShell from "../document-shell/DocumentShell.svelte";
  import WorkHeaderActions from "../work/WorkHeaderActions.svelte";
  import CommentLayer from "../comments/CommentLayer.svelte";
  import { CommentMark } from "../editor/commentMark";
  import { getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { formatInlineComments } from "../../contexts/workspace/session.utils";
  import { workBreadcrumb } from "./lib/breadcrumb";
  import { openThreads } from "../comments/lib/thread";
  import type { PlanComment, PlanCommentReply, SessionMeta, WorkStorage } from "../../shared/types";

  interface DocumentModalProps {
    document: { title: string; content: string };
    /** Work id — enables comments + send-to-agent. Absent for ad-hoc previews. */
    workId?: string;
    onSave?: (content: string) => Promise<void> | void;
    onDirtyChange?: (dirty: boolean) => void;
    onClose?: () => void;
    inline?: boolean;
    minimizeOutline?: boolean;
    onOpenChat?: (mode: 'resume' | 'new') => void;
    originalSessionMeta?: SessionMeta | null;
    /** Work kind — gates the Download .md action in the header. */
    docType?: "doc" | "slides" | "diagram";
    /** Restore the previous snapshot. */
    onRevert?: () => void;
    /** Delete the work (closes the pane + offers undo). */
    onDelete?: () => void;
    /** Duplicate the work into a new independent copy. */
    onDuplicate?: () => void | Promise<void>;
    workStorage?: WorkStorage;
    onPromoteToProject?: () => void | Promise<void>;
    promoting?: boolean;
    /** Rename the work title. */
    onRename?: (title: string) => void;
  }

  let { document: doc, workId, onSave, onDirtyChange, onClose, inline = false, minimizeOutline = false, onOpenChat, originalSessionMeta, docType, onRevert, onDelete, onDuplicate, workStorage, onPromoteToProject, promoting = false, onRename }: DocumentModalProps = $props();

  const session = getWorkspaceContext();
  const commentExtensions = [CommentMark];

  /** 252px of thread card, plus the connector gutter it hangs off and the 24px
   *  page gutter after it. Fixed, never fluid — a margin that resized with the
   *  pane would reflow every thread in it as the window moved. */
  const RAIL_WIDTH = "18.8125rem";

  // Editor handles owned by the shell, surfaced here to drive comments.
  let shell: DocumentShell | null = $state(null);
  let commentLayer: CommentLayer | null = $state(null);
  let tiptapEditor: Editor | null = $state(null);
  let scrollContainer: HTMLDivElement | null = $state(null);
  let suppressSave = $state(false);
  // Owned by CommentLayer, read by the shell's selection bubble.
  let canComment = $state(false);
  // The threads' own visibility. Its toggle lives in the header, because the
  // count is one of the few things the design keeps on screen at every width.
  let railOpen = $state(true);

  const comments = $derived(workId ? session.worksStore.annotationComments(workId) : []);
  const openCount = $derived(openThreads(comments).length);
  // Published by the comment layer, read by the outline's per-section counts.
  let threadAnchors = $state<{ id: string; pos: number }[]>([]);
  let loadedForWorkId: string | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  // Load the annotation sidecar whenever the open work changes.
  $effect(() => {
    const id = workId;
    if (!id) {
      loadedForWorkId = null;
      return;
    }
    if (id === loadedForWorkId) return;
    loadedForWorkId = id;
    void session.worksStore.loadAnnotations(id);
  });

  function persist() {
    if (!workId) return;
    if (saveTimer) clearTimeout(saveTimer);
    const id = workId;
    saveTimer = setTimeout(() => {
      const ann = {
        version: 1 as const,
        workId: id,
        comments: $state.snapshot(session.worksStore.annotationComments(id)) as PlanComment[],
        updatedAt: Date.now(),
      };
      void window.solus.saveWorkAnnotations(ann);
    }, 400);
  }

  function addComment(c: PlanComment) {
    if (!workId) return;
    session.worksStore.addAnnotationComment(workId, c);
    persist();
  }
  function editComment(commentId: string, text: string) {
    if (!workId) return;
    session.worksStore.editAnnotationComment(workId, commentId, text);
    persist();
  }
  function deleteComment(commentId: string) {
    if (!workId) return;
    session.worksStore.deleteAnnotationComment(workId, commentId);
    persist();
  }
  function replyToComment(commentId: string, reply: PlanCommentReply) {
    if (!workId) return;
    session.worksStore.addAnnotationReply(workId, commentId, reply);
    persist();
  }
  function resolveComment(commentId: string, resolved: boolean) {
    if (!workId) return;
    session.worksStore.setAnnotationResolved(workId, commentId, resolved ? "you" : null);
    persist();
  }
  function readComment(commentId: string) {
    if (!workId) return;
    session.worksStore.markAnnotationRead(workId, commentId);
    persist();
  }

  /** Find the chat bound to this work, opening one if there isn't one yet. */
  async function boundChatTabId(): Promise<string | null> {
    const existing = session.tabOrder.find((t) => session.sessionFor(t)?.boundWorkId === workId);
    if (existing) return existing;
    if (!workId) return null;
    await session.openChatForWork(workId, "new");
    return session.tabOrder.find((t) => session.sessionFor(t)?.boundWorkId === workId) ?? null;
  }

  /** Selection → the work's chat, quoted and *not* sent. The user still has to
   *  say what they want done with it, so this prefills the composer and puts
   *  the caret there rather than firing a half-formed prompt at the agent.
   *  Called with no text from the slash menu, where there's nothing to quote. */
  async function askSolusAbout(selectedText: string) {
    if (!workId) return;
    const tabId = await boundChatTabId();
    if (!tabId) return;
    session.selectTab(tabId);
    const tab = session.tabs[tabId];
    // Never clobber something already half-typed in that composer.
    if (tab && selectedText && !tab.input.text) {
      const quote = selectedText
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      tab.input.text = `${quote}\n\n`;
    }
    requestInputFocus({ tabId });
  }

  // Mirror the standard submit-to-agent flow (InputBar / diff feedback): guard
  // against double-sends while the chat tab is being opened.
  let sending = $state(false);
  async function handleSendComments() {
    if (sending || openCount === 0) return;
    sending = true;
    try {
      await sendCommentsToAgent();
    } finally {
      sending = false;
    }
  }

  async function sendCommentsToAgent() {
    if (!workId) return;
    const unresolved = openThreads(comments);
    if (unresolved.length === 0) return;
    const body = formatInlineComments(unresolved);
    const msg = `Please address these comments on "${doc.title}" (work_id: ${workId}):\n${body}`;

    // Handed to the agent, so the threads are settled — they *resolve* rather
    // than vanish. The mark keeps its dotted sage trace, so the reader can
    // still see where the conversation happened; deleting them outright made
    // a whole round of feedback disappear from the page with no record.
    for (const c of unresolved) {
      session.worksStore.setAnnotationResolved(workId, c.id, "solus");
    }
    persist();

    const boundTabId = session.tabOrder.find((t) => session.sessionFor(t)?.boundWorkId === workId);
    if (boundTabId) session.selectTab(boundTabId);
    else await session.openChatForWork(workId, "new");
    session.sendMessage(msg);
  }
</script>

<DocumentShell
  bind:this={shell}
  title={doc.title}
  breadcrumb={workBreadcrumb(workStorage)}
  content={doc.content}
  onRenameTitle={onRename}
  {inline}
  {minimizeOutline}
  editorClass="doc-document-editor"
  rootClass="doc-modal-shell"
  scope="document-modal"
  bindings={{ close: "document-modal.close", save: "document-modal.save", copy: "document-modal.copy", googleUpload: "document-modal.google-upload", find: "document-modal.find", pinOutline: "document-modal.pin-outline" }}
  extraExtensions={workId ? commentExtensions : []}
  onSave={(md) => onSave?.(md)}
  {onDirtyChange}
  onClose={() => onClose?.()}
  onCommentSelection={workId ? () => commentLayer?.startComment() : undefined}
  canCommentSelection={canComment}
  {threadAnchors}
  railWidth={workId ? RAIL_WIDTH : "0px"}
  onAskSolus={workId ? askSolusAbout : undefined}
  bind:tiptapEditor
  bind:scrollContainer
  bind:suppressSave
  rootTestId="document-modal"
  closeTestId="document-modal-close"
  scrollAriaLabel="Document"
  placeholder="Start writing…"
>
  {#snippet documentMeta()}
    <!-- Amber is annotation everywhere in this document, so the count wears a
         swatch of the same hue as the marks it counts rather than an icon. -->
    {#if workId && comments.length > 0}
      <button
        type="button"
        class="dm-comment-count"
        class:dm-comment-count--on={railOpen}
        onclick={() => (railOpen = !railOpen)}
        data-testid="toggle-comments"
        title={railOpen ? "Hide comments" : "Show comments"}
        aria-pressed={railOpen}
      >
        <span class="dm-comment-count__swatch" aria-hidden="true"></span>
        {openCount} open
      </button>
    {/if}
  {/snippet}

  {#snippet documentActions({ copied, copy, googleUpload, uploading, uploaded, startRename })}
    <WorkHeaderActions
      {onOpenChat}
      onStartRename={startRename}
      {originalSessionMeta}
      {copied}
      {copy}
      {workId}
      title={doc.title}
      currentContent={doc.content}
      {docType}
      {onRevert}
      {onDelete}
      {onDuplicate}
      {workStorage}
      {onPromoteToProject}
      {promoting}
      onGoogleUpload={googleUpload}
      {uploading}
      {uploaded}
    />
  {/snippet}

  {#snippet rail({ folded })}
    {#if workId}
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
        startCommentBinding="document-modal.start-comment"
        flushSave={() => shell?.flushSave() ?? Promise.resolve()}
        bind:suppressSave
        bind:canComment
        bind:railOpen
        bind:threadAnchors
      >
        {#snippet footer()}
          <div class="dm-send-bar">
            <span class="dm-send-bar__hint">
              {openCount} open thread{openCount === 1 ? "" : "s"}
            </span>
            <TooltipUI.Root>
              <TooltipUI.Trigger>
                {#snippet child({ props: tooltipProps })}
                  <span {...tooltipProps} class="inline-flex">
                    <Button
                      size="icon"
                      class="rounded-full"
                      data-testid="send-comments"
                      disabled={sending || openCount === 0}
                      onclick={handleSendComments}
                      aria-label="Send comments to agent"
                    >
                      <ArrowUpIcon size={16} weight="bold" />
                    </Button>
                  </span>
                {/snippet}
              </TooltipUI.Trigger>
              <TooltipUI.Content value={"Send to agent"} />
            </TooltipUI.Root>
          </div>
        {/snippet}
      </CommentLayer>
    {/if}
  {/snippet}
</DocumentShell>

<style>
  /* Reading typography (measure, type scale, heading rhythm, code and table
     treatment) is the shared doc-shell column in index.css — this surface only
     keeps what is genuinely its own. */
  @media (max-width: 767px) {
    :global(.doc-document-editor .solus-doc-raw) {
      padding: 0.75rem 1.125rem 2rem;
    }
  }

  /* An unfilled header verb like the rest of the cluster — the count is the
     label, so it needs no icon and no surface of its own. */
  .dm-comment-count {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    flex-shrink: 0;
    height: 1.75rem;
    padding: 0 0.625rem;
    border: none;
    border-radius: 0.4375rem;
    background: transparent;
    font-family: inherit;
    font-size: 0.78125rem;
    font-weight: 400;
    font-variant-numeric: tabular-nums;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium);
  }
  .dm-comment-count:hover,
  .dm-comment-count--on {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
  .dm-comment-count:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border);
    outline-offset: 0.0625rem;
  }
  .dm-comment-count__swatch {
    width: 0.4375rem;
    height: 0.4375rem;
    border-radius: 0.125rem;
    background: color-mix(in srgb, var(--solus-art-2) 55%, transparent);
  }
  .dm-comment-count--on .dm-comment-count__swatch {
    background: var(--solus-art-2);
  }

  /* Submit lives at the bottom of the comments rail and uses the canonical accent
     send button shared with the input bar and diff-feedback composer, so sending
     comments to the agent looks and feels identical to every other page. */
  .dm-send-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    /* A hairline, not a footer bar — the margin has no second surface in it. */
    margin-top: 0.5rem;
    padding: 0.625rem 0.125rem 0;
    border-top: 0.0625rem solid color-mix(in srgb, var(--solus-art-border) 55%, transparent);
  }
  .dm-send-bar__hint {
    font-size: 0.6875rem;
    color: var(--solus-text-tertiary);
    font-variant-numeric: tabular-nums;
  }

  /* Narrow pane (split, or a compact window): collapse actions to icon-only. */
  @container doc-shell (max-width: 34rem) {
    :global(.doc-modal-shell .wha-label) {
      display: none;
    }
    :global(.doc-modal-shell .wha-solus-trigger) {
      padding-inline: 0.375rem;
    }
  }
</style>
