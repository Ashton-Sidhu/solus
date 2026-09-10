<script lang="ts">
  import type { Editor } from "@tiptap/core";
  import { ArrowUp as ArrowUpIcon, MessageSquare as CommentIcon } from "@lucide/svelte";
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";
  import { Button } from "../ui/button";
  import DocumentShell from "../document-shell/DocumentShell.svelte";
  import { googleQuoteRange } from "../work/lib/google-comment-quote";
  import { ExternalCommentHighlights, updateExternalCommentHighlights, externalCommentRange } from "../work/lib/external-comment-highlights";
  import { formatExternalThreadsForAgent, localCommentsForDisplay } from "../work/lib/external-comments-view";
  import { removeCommentMark } from "../plan/lib/comments";
  import type { DocCommentThread } from "@solus/contracts/work-comments";
  import { uuid } from "@solus/contracts/uuid";
  import WorkHeaderActions from "../work/WorkHeaderActions.svelte";
  import type { WorkExportFormat, WorkExportRequest } from "../work/lib/work-export";
  import CommentLayer from "../comments/CommentLayer.svelte";
  import { CommentMark } from "../editor/commentMark";
  import { getClientShellContext, getWorkspaceContext } from "../../contexts";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { setMarkdownImageContext } from "../conversation/lib/markdown-image";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { formatInlineComments } from "../../contexts/workspace/session.utils";
  import { workBreadcrumb } from "./lib/breadcrumb";
  import { openThreads } from "../comments/lib/thread";
  import type { PlanComment, PlanCommentReply, SessionMeta, WorkStorage } from "@solus/contracts/types";

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
    /** Restore the previous snapshot. */
    onRevert?: () => void;
    /** Delete the work (closes the pane + offers undo). */
    onDelete?: () => void;
    /** Duplicate the work into a new independent copy. */
    onDuplicate?: () => void | Promise<void>;
    workStorage?: WorkStorage;
    /** Opens the save picker on a chosen format; absent when there is no host. */
    onExport?: (request: WorkExportRequest) => void;
    /** The save picker's filesystem is not this device's — see WorkHeaderActions. */
    hostIsRemote?: boolean;
    /** Rename the work title. */
    onRename?: (title: string) => void;
    /** Leave the document for the Workspace page it lives in. */
    onOpenWorkspace?: () => void;
  }

  let { document: doc, workId, onSave, onDirtyChange, onClose, inline = false, minimizeOutline = false, onOpenChat, originalSessionMeta, onRevert, onDelete, onDuplicate, workStorage, onExport, hostIsRemote = false, onRename, onOpenWorkspace }: DocumentModalProps = $props();

  const session = getWorkspaceContext();
  const clientShell = getClientShellContext();
  setMarkdownImageContext({
    cwd: () => undefined,
    serverId: () => workId ? session.worksStore.hostFor(workId) ?? undefined : undefined,
    ctx: () => undefined,
    isWeb: () => !clientShell.supportsLocalAttachments,
    api: () => {
      const serverId = workId ? session.worksStore.hostFor(workId) : null;
      return serverId ? serverConnections.apiFor(serverId) : undefined;
    },
  });
  const commentExtensions = [CommentMark, ExternalCommentHighlights];

  // A document is one file: its own markdown. The header still renders it
  // through the shared format list so Save and Download read the same way here
  // as they do on a diagram.
  const exportFormats: WorkExportFormat[] = [
    {
      extension: "md",
      label: "Markdown",
      mimeType: "text/markdown",
      produce: () => ({
        contents: shell?.getCurrentMarkdown() ?? doc.content,
        encoding: "utf8",
      }),
    },
  ];

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
  const readOnly = $derived(workId ? session.worksStore.get(workId)?.mirroredDoc?.provider === "gdrive" : false);
  const hasExternalDoc = $derived(workId ? !!session.worksStore.get(workId)?.mirroredDoc : false);
  const externalSnapshot = $derived(workId && hasExternalDoc ? session.worksStore.externalComments.stateFor(workId) : undefined);
  // Deleted threads are the provider's own tombstones; nothing reads them here.
  const externalThreads = $derived(externalSnapshot?.threads.filter(thread => !thread.deleted) ?? []);

  $effect(() => {
    if (workId && hasExternalDoc) return session.worksStore.externalComments.watch(workId);
  });

  $effect(() => {
    if (tiptapEditor && !tiptapEditor.isDestroyed) updateExternalCommentHighlights(tiptapEditor, externalSnapshot, workId);
  });

  function locateExternalQuote(quote: string, threadId: string): boolean {
    if (!tiptapEditor || tiptapEditor.isDestroyed) return false;
    const range = externalCommentRange(tiptapEditor, threadId) ?? googleQuoteRange(tiptapEditor.state.doc, quote);
    if (!range) return false;
    tiptapEditor.chain().focus().setTextSelection(range).scrollIntoView().run();
    return true;
  }

  async function askPrivately(thread: DocCommentThread) {
    if (!workId) return;
    const id = workId;
    const comment: PlanComment = { id: uuid(), externalThreadId: thread.id, selectedText: thread.quote, comment: `Review this external comment privately: ${thread.text}`, author: 'you', createdAt: Date.now() };
    session.worksStore.addAnnotationComment(id, comment);
    await session.worksStore.saveAnnotations(id);
    await session.openChatForWork(id, 'new');
    if (!session.leadingInput.text) session.leadingInput.text = `Please review local comment ${comment.id} on work ${id}. Keep the discussion in Solus. Do not post to the external document.`;
    requestInputFocus();
  }

  const localComments = $derived(workId ? session.worksStore.annotationComments(workId) : []);
  const comments = $derived(localCommentsForDisplay(localComments, externalSnapshot));
  $effect(() => {
    if (!tiptapEditor || tiptapEditor.isDestroyed) return;
    const visible = new Set(comments.map(comment => comment.id));
    suppressSave = true;
    for (const comment of localComments) {
      if (!visible.has(comment.id)) removeCommentMark(tiptapEditor, comment.id);
    }
    suppressSave = false;
  });
  // The count is the whole surface, which holds both kinds of thread: the
  // header reads it, and the send bar sends exactly what it counts.
  const openThreadCount = $derived(openThreads(comments).length + externalThreads.filter(thread => !thread.resolved).length);
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
      void session.worksStore.saveAnnotations(id);
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

  /** Selection → the work's chat, quoted and *not* sent. The user still has to
   *  say what they want done with it, so this prefills the composer and puts
   *  the caret there rather than firing a half-formed prompt at the agent.
   *  Called with no text from the slash menu, where there's nothing to quote. */
  async function askSolusAbout(selectedText: string) {
    if (!workId) return;
    await session.openChatForWork(workId, "new");
    const prompt = session.leadingInput;
    // Never clobber something already half-typed in that composer.
    if (selectedText && !prompt.text) {
      const quote = selectedText
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      prompt.text = `${quote}\n\n`;
    }
    requestInputFocus();
  }

  // Mirror the standard submit-to-agent flow (InputBar / diff feedback): guard
  // against double-sends while the chat tab is being opened.
  let sending = $state(false);
  async function handleSendComments() {
    if (sending || openThreadCount === 0) return;
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
    // The rail holds both kinds of thread, so the button sends both. The
    // external ones travel as context the agent may not answer upstream.
    const external = externalSnapshot ? formatExternalThreadsForAgent(externalSnapshot.threads, externalSnapshot.provider) : "";
    if (unresolved.length === 0 && !external) return;
    const body = unresolved.length > 0 ? formatInlineComments(unresolved) : "There are no open Solus comments.";
    const msg = `Please address these comments on "${doc.title}" (work_id: ${workId}):\n${body}${external}`;

    const sent = await session.sendMessageToNewWorkSession(workId, msg);
    if (!sent) return;

    // Handed to the agent, so the threads are settled — they *resolve* rather
    // than vanish. The mark keeps its dotted sage trace, so the reader can
    // still see where the conversation happened; deleting them outright made
    // a whole round of feedback disappear from the page with no record.
    for (const c of unresolved) {
      session.worksStore.setAnnotationResolved(workId, c.id, "solus");
    }
    persist();
  }
</script>

<DocumentShell
  bind:this={shell}
  title={doc.title}
  breadcrumb={workBreadcrumb(workStorage)}
  {onOpenWorkspace}
  content={doc.content}
  onRenameTitle={readOnly ? undefined : onRename}
  {readOnly}
  {inline}
  {minimizeOutline}
  editorClass="doc-document-editor"
  rootClass="doc-modal-shell"
  scope="document-modal"
  bindings={{ close: "document-modal.close", save: "document-modal.save", copy: "document-modal.copy", find: "document-modal.find", pinOutline: "document-modal.pin-outline" }}
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
    <!-- This snippet renders inside the shell's own verb cluster, so it wears
         that cluster's type rung (`--text-chrome-dense`), ink and hover wash
         rather than a rung of its own — `doc-shell-header-btn` is scoped to the
         shell and cannot reach markup passed in from here. Mobile puts the same
         snippet in the compact toolbar row, whose buttons are 40px, and those
         are keyed to the shell's own 767px query, so this matches it. -->
    {#if readOnly}<span class="text-[length:var(--text-chrome-dense)] text-(--solus-text-tertiary)" title="Edit in Google Docs, then Pull latest. Comments remain available.">Read-only</span>{/if}
    <!-- One of the meta line's own words, not a chip on top of it: the glyph
         says what the number counts, so the count needs no unit spelled out and
         no surface of its own. The rail appearing beside the page is the state;
         deepening the ink here as well only made the count look mis-set against
         the verbs either side of it. The glyph is sized in `em` so it tracks
         whichever rung the row is on, and lightened to the weight of the type
         it sits in — lucide's default stroke reads bold at this size. -->
    {#if workId && (comments.length > 0 || externalThreads.length > 0)}
      <button
        type="button"
        class="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.75 text-[length:var(--text-chrome-dense)] text-(--solus-text-tertiary) tabular-nums transition-colors hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--solus-accent-border) max-md:h-10 max-md:rounded-lg max-md:px-2.5"
        onclick={() => (railOpen = !railOpen)}
        data-testid="toggle-comments"
        title={railOpen ? "Hide comments" : "Show comments"}
        aria-label={`${openThreadCount} open comment${openThreadCount === 1 ? "" : "s"} — ${railOpen ? "hide" : "show"}`}
        aria-pressed={railOpen}
      >
        <CommentIcon class="size-[0.9em]" strokeWidth={1.75} aria-hidden="true" />
        {openThreadCount}
      </button>
    {/if}
  {/snippet}

  {#snippet documentActions({ copied, copy, startRename })}
    <WorkHeaderActions
      {onOpenChat}
      onStartRename={startRename}
      {originalSessionMeta}
      {copied}
      {copy}
      {workId}
      title={doc.title}
      currentContent={doc.content}
      getCurrentContent={() => shell?.getCurrentMarkdown() ?? doc.content}
      flushSave={() => shell?.flushSave() ?? Promise.resolve()}
      onRevert={readOnly ? undefined : onRevert}
      {onDelete}
      {onDuplicate}
      {workStorage}
      {exportFormats}
      {onExport}
      {hostIsRemote}
    />
  {/snippet}

  {#snippet rail({ folded })}
    {#if workId}
      <CommentLayer
        externalWorkId={hasExternalDoc ? workId : undefined}
        externalThreads={hasExternalDoc ? externalThreads : []}
        onAskExternalPrivately={askPrivately}
        onLocateExternalQuote={locateExternalQuote}
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
              {openThreadCount} open thread{openThreadCount === 1 ? "" : "s"}
            </span>
            <TooltipUI.Root>
              <TooltipUI.Trigger>
                {#snippet child({ props: tooltipProps })}
                  <span {...tooltipProps} class="inline-flex">
                    <Button
                      size="icon"
                      class="rounded-full"
                      data-testid="send-comments"
                      disabled={sending || openThreadCount === 0}
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
    font-size: var(--text-xs);
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
