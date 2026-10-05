<script lang="ts">
  import { liveStatus, type LiveStatusInput } from "../work/lib/live-status";
  import WorkSavedStatus from "../work/WorkSavedStatus.svelte";
  import SessionNameInput from "../session/SessionNameInput.svelte";
  import WorkHeaderActions from "../work/WorkHeaderActions.svelte";
  import ParentPageCrumb from "../ui/list-page/ParentPageCrumb.svelte";
  import type { WorkCopyFormat, WorkExportFormat, WorkExportRequest } from "../work/lib/work-export";
  import { formatSavedAgo } from "../document-shell/saveStatus";
  import { toasts } from "../../lib/toasts";
  import type { DiagramSaver } from "./lib/diagram-save.svelte";

  interface Props {
    title: string;
    saver: DiagramSaver;
    /** A live diagram shows its live status instead of saves. */
    liveState?: LiveStatusInput | null;
    /** The saved text of the diagram as it is now. */
    currentText: () => string;
    /** The content the work was opened with. */
    content: string;
    workId?: string;
    onRename?: (title: string) => void;
    onOpenWorkspace?: () => void;
    onDelete?: () => void;
    onDuplicate?: () => void | Promise<void>;
    exportFormats: WorkExportFormat[];
    copyFormats: WorkCopyFormat[];
    onExport?: (request: WorkExportRequest) => void;
    hostIsRemote: boolean;
    /** Why the reader may not edit; null for an editor. */
    readOnlyReason?: string | null;
  }

  let {
    title,
    saver,
    liveState = null,
    currentText,
    content,
    workId,
    onRename,
    onOpenWorkspace,
    onDelete,
    onDuplicate,
    exportFormats,
    copyFormats,
    onExport,
    hostIsRemote,
    readOnlyReason = null,
  }: Props = $props();

  // Double-click to rename, like the session crumb. The field commits on
  // Enter or blur and cancels on Escape (`SessionNameInput`).
  let renaming = $state(false);
  function startRename() {
    renaming = true;
  }

  let copied = $state(false);
  function copyDiagram() {
    navigator.clipboard
      .writeText(currentText())
      .then(() => {
        copied = true;
        setTimeout(() => (copied = false), 1800);
      })
      .catch(() => toasts.error("Copy failed"));
  }

  // A slow clock keeps "Saved 2m ago" honest.
  let now = $state(Date.now());
  $effect(() => {
    if (saver.lastSavedAt === null) return;
    now = saver.lastSavedAt;
    const interval = setInterval(() => (now = Date.now()), 10_000);
    return () => clearInterval(interval);
  });
</script>

<!-- De-chromed control strip: no border, no chrome-row height. The crumb
     says which page the diagram lives in and takes the reader back; its leaf
     is the title, which is otherwise the tab label's job. The pane's close /
     split / maximize live in the floating PaneChrome cluster, which this row
     reserves room for on its right. -->
<div class="diagram-shell__toolbar workspace-titlebar">
  {#if onOpenWorkspace}
    <!-- The optical inset pulls a *word* back onto the row's edge. A chevron
         is already centred in its own 44px box, so the rung gives it back. -->
    <span class="-ml-[7px] flex shrink-0 items-center @max-[30rem]/pane:ml-0">
      <ParentPageCrumb page="folio" onOpen={onOpenWorkspace} />
    </span>
  {/if}
  {#if renaming}
    <span class="flex h-[1.875rem] w-80 min-w-24 max-w-full shrink items-center">
      <SessionNameInput
        value={title}
        variant="row"
        class="text-workspace-chrome font-medium"
        onCommit={(next) => {
          renaming = false;
          onRename?.(next);
        }}
        onCancel={() => (renaming = false)}
      />
    </span>
  {:else if onRename}
    <button
      type="button"
      class="min-w-0 truncate rounded-md border-0 bg-transparent px-1 py-0.5 text-left text-workspace-chrome font-medium text-(--solus-text-primary) hover:bg-(--solus-surface-hover) focus-visible:outline-2 focus-visible:outline-(--solus-accent-border) pointer-coarse:min-h-11"
      ondblclick={startRename}
      title="{title} — double-click to rename"
      aria-label={`Rename diagram: ${title}`}
    >{title}</button>
  {:else}
    <span
      class="min-w-0 truncate text-workspace-chrome font-medium text-(--solus-text-primary)"
      title={title}>{title}</span
    >
  {/if}
  <div class="diagram-shell__save-status">
    <!-- A reader saves nothing, so the slot says why the canvas does not edit.
         A live connection's trouble still wins: it is news to a reader too. -->
    {#if readOnlyReason && (!liveState || liveStatus(liveState).tone === "ok")}
      <span data-testid="diagram-read-only" title={readOnlyReason}>Read-only</span>
      <span class="@max-[30rem]/pane:hidden">· {readOnlyReason}</span>
    {:else if liveState}
      {@const status = liveStatus(liveState)}
      {#if status.label === "Saved"}
        <WorkSavedStatus />
      {:else}
        <span class="size-1.5 shrink-0 rounded-full {status.tone === 'warn' ? 'bg-(--solus-status-error)' : 'bg-(--solus-accent)'}" aria-hidden="true"></span>
        <span data-testid="live-status">{status.label}</span>
      {/if}
    {:else if saver.showSaving}
      <span class="diagram-shell__save-dot" aria-hidden="true"></span>
      <span>Saving…</span>
    {:else if saver.saveFailed}
      <button
        type="button"
        class="diagram-shell__save-retry"
        onclick={() => saver.retry()}
        title={saver.saveError
          ? `${saver.saveError} Click to retry.`
          : "The last save failed — click to retry"}
      >
        Save failed — retry
      </button>
    {:else if saver.lastSavedAt !== null}
      <WorkSavedStatus label={formatSavedAgo(saver.lastSavedAt, now)} />
    {/if}
  </div>
  <div class="diagram-shell__toolbar-spacer"></div>
  <WorkHeaderActions
    onStartRename={onRename ? startRename : undefined}
    {copied}
    copy={copyDiagram}
    {workId}
    {title}
    currentContent={content}
    getCurrentContent={currentText}
    {onDelete}
    {onDuplicate}
    {exportFormats}
    {copyFormats}
    {onExport}
    {hostIsRemote}
  />
</div>
