<script lang="ts">
  import type { Editor } from "@tiptap/core";
  import { FileTextIcon } from "phosphor-svelte";
  import DocumentShell from "../document-shell/DocumentShell.svelte";
  import WorkHeaderActions from "../work/WorkHeaderActions.svelte";
  import CommentLayer from "../comments/CommentLayer.svelte";
  import { CommentMark } from "../editor/commentMark";
  import { removeCommentMark } from "../plan/lib/comments";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { formatInlineComments } from "../../contexts/session.utils";
  import type { PaneSlot } from "../../contexts/pane-view.store.svelte";
  import type { PlanComment, SessionMeta, WorkStorage } from "../../shared/types";

  interface DocumentModalProps {
    document: { title: string; content: string };
    /** Work id — enables comments + send-to-agent. Absent for ad-hoc previews. */
    workId?: string;
    onSave?: (content: string) => Promise<void> | void;
    onDirtyChange?: (dirty: boolean) => void;
    onClose?: () => void;
    inline?: boolean;
    slot?: PaneSlot;
    onOpenInSplit?: () => void;
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

  let { document: doc, workId, onSave, onDirtyChange, onClose, inline = false, slot = "primary", onOpenInSplit, onOpenChat, originalSessionMeta, docType, onRevert, onDelete, onDuplicate, workStorage, onPromoteToProject, promoting = false, onRename }: DocumentModalProps = $props();

  const session = getWorkspaceContext();
  const commentExtensions = [CommentMark];

  // Editor handles owned by the shell, surfaced here to drive comments.
  let shell: DocumentShell | null = $state(null);
  let tiptapEditor: Editor | null = $state(null);
  let scrollContainer: HTMLDivElement | null = $state(null);
  let suppressSave = $state(false);

  const comments = $derived(workId ? session.worksStore.annotationComments(workId) : []);
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

  async function sendCommentsToAgent() {
    if (!workId || comments.length === 0) return;
    const body = formatInlineComments(comments);
    const msg = `Please address these comments on "${doc.title}" (work_id: ${workId}):\n${body}`;

    // The comments have been handed to the agent, so clear them and their editor
    // marks — same as the diff-feedback flow. Done before the pane switch below
    // (which remounts the editor) so the rail empties immediately on submit.
    if (tiptapEditor) {
      suppressSave = true;
      for (const c of comments) removeCommentMark(tiptapEditor, c.id);
      suppressSave = false;
    }
    session.worksStore.clearAnnotationComments(workId);
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
  content={doc.content}
  onRenameTitle={onRename}
  {inline}
  iconOnlyHeaderActions={slot === "secondary"}
  editorClass="doc-document-editor"
  rootClass="doc-modal-shell"
  scope="document-modal"
  bindings={{ close: "document-modal.close", save: "document-modal.save", copy: "document-modal.copy", googleUpload: "document-modal.google-upload", find: "document-modal.find" }}
  extraExtensions={workId ? commentExtensions : []}
  onSave={(md) => onSave?.(md)}
  {onDirtyChange}
  onClose={() => onClose?.()}
  bind:tiptapEditor
  bind:scrollContainer
  bind:suppressSave
  rootTestId="document-modal"
  closeTestId="document-modal-close"
  scrollAriaLabel="Document"
  placeholder="Start writing…"
>
  {#snippet titleIcon()}
    <FileTextIcon size={14} class="text-(--solus-text-tertiary) shrink-0" />
  {/snippet}

  {#snippet headerActions({ copied, copy, googleUpload, uploading, uploaded })}
    <WorkHeaderActions
      {inline}
      paneSlot={slot}
      {onOpenInSplit}
      {onOpenChat}
      {originalSessionMeta}
      iconOnly={slot === "secondary"}
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

  {#snippet rail()}
    {#if workId}
      <CommentLayer
        editor={tiptapEditor}
        {scrollContainer}
        {comments}
        onAdd={addComment}
        onEdit={editComment}
        onDelete={deleteComment}
        onSendToAgent={sendCommentsToAgent}
        flushSave={() => shell?.flushSave() ?? Promise.resolve()}
        bind:suppressSave
      />
    {/if}
  {/snippet}
</DocumentShell>

<style>
  /* Editor content width/typography — mirror the plan modal's reading column so
     the works doc editor looks and feels identical (same measure, type scale,
     heading rhythm, and code-block treatment). */
  :global(.doc-document-editor .solus-doc-editor .ProseMirror) {
    max-width: 65rem;
    font-size: calc(0.9375rem * var(--solus-font-scale, 1));
    line-height: 1.66;
    /* Body at 400 (Regular) so the 600/700 headings get a full 200-unit jump
       and emphasis separates cleanly from the prose. */
    font-weight: 400;
  }
  :global(.doc-document-editor .solus-doc-editor .ProseMirror code) {
    color: color-mix(in srgb, var(--solus-accent) 72%, var(--solus-text-primary));
  }
  :global(.doc-document-editor .solus-doc-editor .ProseMirror pre code) {
    color: inherit;
  }
  /* Wider size jump from body so headings anchor sections (h1 ~1.6× body). */
  :global(.doc-document-editor .solus-doc-editor .ProseMirror h1) {
    font-size: calc(1.5rem * var(--solus-font-scale, 1));
  }
  :global(.doc-document-editor .solus-doc-editor .ProseMirror h2) {
    font-size: calc(1.2rem * var(--solus-font-scale, 1));
  }
  :global(.doc-document-editor .solus-doc-editor .ProseMirror h3) {
    font-size: calc(1.0313rem * var(--solus-font-scale, 1));
  }
  /* Asymmetric spacing — big gap above a heading separates the prior section,
     tight gap below bonds it to the content it leads. */
  :global(.doc-document-editor .solus-doc-editor .ProseMirror h1),
  :global(.doc-document-editor .solus-doc-editor .ProseMirror h2),
  :global(.doc-document-editor .solus-doc-editor .ProseMirror h3) {
    margin-top: 2em;
    margin-bottom: 0.45em;
  }
  :global(.doc-document-editor .solus-doc-editor .ProseMirror h1:first-child),
  :global(.doc-document-editor .solus-doc-editor .ProseMirror h2:first-child),
  :global(.doc-document-editor .solus-doc-editor .ProseMirror h3:first-child) {
    margin-top: 0;
  }
  :global(.doc-document-editor .solus-doc-editor .ProseMirror pre),
  :global(.doc-document-editor .solus-doc-editor .ProseMirror table),
  :global(.doc-document-editor .solus-doc-raw) {
    font-size: calc(0.875rem * var(--solus-font-scale, 1));
  }
  /* Code blocks match chat: outlined block with a faint warm tint (not grey). */
  :global(.doc-document-editor .solus-doc-editor .ProseMirror pre) {
    background: var(--solus-code-tint);
    border-radius: 0.625rem;
    line-height: 1.55;
  }
  :global(.doc-document-editor .solus-doc-editor .ProseMirror table) {
    margin: 0;
  }
  :global(.doc-document-editor .solus-doc-editor .ProseMirror th),
  :global(.doc-document-editor .solus-doc-editor .ProseMirror td) {
    border: 0.0625rem solid var(--solus-container-border);
    padding: 0.4em 0.6em;
    text-align: inherit;
  }
  @container doc-shell (max-width: 112.5rem) {
    :global(.doc-modal-shell .doc-shell-toolbar-row),
    :global(.doc-document-editor .solus-doc-editor .ProseMirror),
    :global(.doc-document-editor .solus-doc-raw) {
      max-width: none;
    }
  }

  /* Tablet / compact — un-cap the toolbar row to align with the editor. */
  @media (max-width: 1100px) and (min-width: 768px) {
    :global(.doc-modal-shell .doc-shell-toolbar-row) {
      max-width: none;
      padding-inline: 1rem;
    }
  }

  /* Mobile typography parity with the plan modal. */
  @media (max-width: 767px) {
    :global(.doc-document-editor .solus-doc-editor .ProseMirror) {
      padding: 0.75rem 1.125rem 2rem;
      font-size: calc(1.0625rem * var(--solus-font-scale, 1));
      line-height: 1.7;
    }
    :global(.doc-document-editor .solus-doc-editor .ProseMirror h1) {
      font-size: calc(1.375rem * var(--solus-font-scale, 1));
    }
    :global(.doc-document-editor .solus-doc-editor .ProseMirror h2) {
      font-size: calc(1.1875rem * var(--solus-font-scale, 1));
    }
    :global(.doc-document-editor .solus-doc-editor .ProseMirror h3) {
      font-size: calc(1.0625rem * var(--solus-font-scale, 1));
    }
    :global(.doc-document-editor .solus-doc-editor .ProseMirror pre),
    :global(.doc-document-editor .solus-doc-editor .ProseMirror table) {
      font-size: calc(0.9375rem * var(--solus-font-scale, 1));
    }
    :global(.doc-document-editor .solus-doc-raw) {
      padding: 0.75rem 1.125rem 2rem;
      font-size: calc(1rem * var(--solus-font-scale, 1));
      line-height: 1.66;
    }
  }
  /* Split pane / narrow pane: collapse action buttons to icon-only */
  :global(.doc-modal-shell .wha-actions--icon-only .wha-label) {
    display: none;
  }
  :global(.doc-modal-shell .wha-actions--icon-only .wha-caret) {
    display: none;
  }
  :global(.doc-modal-shell .wha-actions--icon-only .wha-chat-trigger),
  :global(.doc-modal-shell .wha-actions--icon-only .soft-pill) {
    padding-inline: 0.3125rem;
  }
  @container doc-shell (max-width: 34rem) {
    :global(.doc-modal-shell .wha-label) {
      display: none;
    }
    :global(.doc-modal-shell .wha-chat-trigger),
    :global(.doc-modal-shell .soft-pill) {
      padding-inline: 0.3125rem;
    }
  }
</style>
