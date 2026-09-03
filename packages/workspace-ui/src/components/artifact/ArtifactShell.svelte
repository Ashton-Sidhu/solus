<script lang="ts">
  import type { SessionMeta, WorkStorage } from "@solus/contracts/types";
  import WorkHeaderActions from "../work/WorkHeaderActions.svelte";
  import ParentPageCrumb from "../ui/list-page/ParentPageCrumb.svelte";
  import type { WorkExportFormat, WorkExportRequest } from "../work/lib/work-export";
  import ArtifactView from "./ArtifactView.svelte";

  /**
   * The pane surface for an `artifact` work: the works header the document
   * and diagram shells share, over the same sandboxed render the conversation
   * shows. There is no editor — an artifact is revised by the agent through
   * `update_work`, and the header's History/Restore covers what it changed.
   */
  interface Props {
    content: string;
    title: string;
    workId: string;
    onClose: () => void;
    onOpenChat?: (mode: "resume" | "new") => void;
    originalSessionMeta?: SessionMeta | null;
    onRename?: (title: string) => void;
    onRevert?: () => void;
    onDelete?: () => void;
    onDuplicate?: () => void | Promise<void>;
    workStorage?: WorkStorage;
    /** Opens the save picker on a chosen format; absent when there is no host. */
    onExport?: (request: WorkExportRequest) => void;
    /** The save picker's filesystem is not this device's — see WorkHeaderActions. */
    hostIsRemote?: boolean;
    /** Leave the artifact for the Workspace page it lives in. */
    onOpenWorkspace?: () => void;
  }

  let {
    content,
    title,
    workId,
    onClose,
    onOpenChat,
    originalSessionMeta,
    onRename,
    onRevert,
    onDelete,
    onDuplicate,
    workStorage,
    onExport,
    hostIsRemote = false,
    onOpenWorkspace,
  }: Props = $props();

  // Click-to-rename, mirroring DiagramShell.
  let renaming = $state(false);
  let renameValue = $state("");
  function startRename() {
    if (!onRename) return;
    renameValue = title;
    renaming = true;
  }
  function commitRename() {
    if (!renaming) return;
    renaming = false;
    const next = renameValue.trim();
    if (next && next !== title) onRename?.(next);
  }
  function renameKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.currentTarget instanceof HTMLInputElement) e.currentTarget.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      renaming = false;
    }
  }

  let copied = $state(false);
  function copyHtml() {
    navigator.clipboard.writeText(content).then(() => {
      copied = true;
      setTimeout(() => (copied = false), 1500);
    });
  }

  // The one file an artifact is: its own HTML document, openable in any browser.
  const exportFormats: WorkExportFormat[] = [
    {
      extension: "html",
      label: "HTML",
      mimeType: "text/html",
      produce: () => (content.trim() ? { contents: content, encoding: "utf8" } : null),
    },
  ];

  const artifact = $derived({ kind: "html" as const, html: content });
</script>

<div
  class="flex h-full min-h-0 flex-col bg-(--solus-container-bg)"
  data-testid="artifact-shell"
>
  <!-- Same de-chromed control strip as the diagram shell: the pane's own
       close / split / maximize live in the floating PaneChrome cluster, which
       this row reserves room for on its right.

       The chrome row is a *floor*, not a fixed height. It used to be fixed with
       a `max-md:` escape hatch — but that reads the OS window, and this row
       lives in a pane: a diagram in a 356px companion pane on a 1440px monitor
       kept the 40px height while its controls grew past it. Two different
       things enlarge this row and neither is the window. The hand does (touch
       targets are 44px), and so does the narrow layout, where the crumb becomes
       a 44px back chevron. `h-auto` + `min-h` fits whichever is tallest without
       having to enumerate them. -->
  <div
    class="workspace-titlebar flex h-auto min-h-[var(--solus-chrome-row-h,2.5rem)] shrink-0 items-center gap-1.5 pl-[max(1rem,var(--solus-chrome-lead-inset,0px))] pr-[max(1rem,var(--solus-pane-chrome-inset,0px))] @max-[30rem]/pane:gap-1 @max-[30rem]/pane:pl-2"
  >
    {#if onOpenWorkspace}
      <!-- The optical inset pulls a *word* back onto the row's edge. A chevron
           is already centred in its own 44px box, so the rung gives it back. -->
      <span class="-ml-[7px] flex shrink-0 items-center @max-[30rem]/pane:ml-0">
        <ParentPageCrumb page="folio" onOpen={onOpenWorkspace} />
      </span>
    {/if}
    {#if renaming}
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="min-w-24 max-w-96 flex-1 rounded-md border border-(--solus-accent-border) bg-(--solus-surface-hover) px-1 py-0.5 text-workspace-chrome font-medium text-(--solus-text-primary) outline-none"
        bind:value={renameValue}
        onblur={commitRename}
        onkeydown={renameKeydown}
        autofocus
        aria-label="Rename artifact"
        data-testid="rename-work-input"
      />
    {:else}
      <button
        type="button"
        class="min-w-0 flex-1 cursor-text truncate border-0 bg-transparent text-left text-workspace-chrome font-medium text-(--solus-text-primary)"
        onclick={startRename}
        disabled={!onRename}
        title={onRename ? "Rename" : undefined}
        data-testid="artifact-shell-title"
      >
        {title}
      </button>
    {/if}
    <WorkHeaderActions
      {onOpenChat}
      onStartRename={onRename ? startRename : undefined}
      {originalSessionMeta}
      {copied}
      copy={copyHtml}
      {workId}
      {title}
      currentContent={content}
      {exportFormats}
      {onExport}
      {hostIsRemote}
      {onRevert}
      {onDelete}
      {onDuplicate}
      {workStorage}
    />
  </div>

  <!-- A short render fills the pane; a taller render keeps its content height
       and scrolls here instead of introducing a second iframe scrollbar. -->
  <div class="min-h-0 flex-1 overflow-auto p-4" data-testid="artifact-shell-body">
    <ArtifactView {artifact} fillAvailable skipMotion />
  </div>
</div>
