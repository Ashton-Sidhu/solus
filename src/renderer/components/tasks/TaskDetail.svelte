<script lang="ts">
  import { untrack } from "svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import {
    PlayIcon,
    ArrowSquareOutIcon,
    CircleNotchIcon,
    GitPullRequestIcon,
    GitBranchIcon,
    CalendarBlankIcon,
    ChatCircleDotsIcon,
    TrashIcon,
    CaretDownIcon,
    CaretRightIcon,
    CheckIcon,
    XIcon,
    ArrowsClockwiseIcon,
  } from "phosphor-svelte";
  import {
    type Task,
    type TaskStatus,
    type TaskPriority,
    type TaskSessionLink,
    taskPrFromUrl,
  } from "../../../shared/task-types";
  import {
    STATUS_META,
    statusLabel,
    taskHydration,
    relativeTime,
    authorInitials,
    dueDateMeta,
    PRIORITY_META,
    type TaskComment,
    type TaskLinkedPr,
  } from "./lib/tasks-api";
  import { formatSavedAgo } from "../document-shell/saveStatus";
  import Dropdown from "../ui/Dropdown.svelte";
  import DropdownItem from "../ui/DropdownItem.svelte";
  import Select from "../ui/Select.svelte";
  import CodeBlock from "../ui/CodeBlock.svelte";
  import MarkdownLink from "../conversation/MarkdownLink.svelte";
  import DocumentPromptEditor from "../editor/DocumentPromptEditor.svelte";
  import PromptEditor from "../ui/PromptEditor.svelte";
  import TaskCommentCodeSpan from "./TaskCommentCodeSpan.svelte";
  import type { AgentId } from "../../../shared/types";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { getAgentContext } from "../../contexts/agent.context.svelte";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";

  interface Props {
    task: Task;
    /** Whether the provider lets us edit content (title/body/labels/assignee) —
     *  local + GitHub. */
    canEdit: boolean;
    /** Whether priority + due date are editable for this task — local always,
     *  GitHub only when the issue is on a Projects v2 board. */
    canEditExtras: boolean;
    /** Whether the local-only work fields (branch + PR) are editable — these have
     *  no GitHub equivalent, so they stay local-only even for board-backed issues. */
    canEditWork: boolean;
    /** Whether the provider supports deleting this ticket (local only). */
    canDelete: boolean;
    /** Whether the provider has a comment model (local + GitHub). */
    canComment: boolean;
    /** Sessions already started from this task, surfaced as jump-back links. */
    linkedSessions: TaskSessionLink[];
    onStart: (task: Task) => void;
    onOpenLink: (task: Task) => void;
    onSetStatus: (task: Task, status: TaskStatus) => void;
    onResumeSession: (task: Task) => void;
    /** Persist edited fields; resolves to the provider's post-write task so the
     *  page reflects its truth. Throws to keep the draft. */
    onSave: (patch: Partial<Task>) => Promise<Task>;
    /** Delete the task (returns to the list; undo is offered upstream). */
    onDelete: (task: Task) => void;
    /** Post a comment; resolves to the re-hydrated task. Throws to keep the draft. */
    onComment: (body: string) => Promise<Task>;
    /** Re-hydrate the full ticket (body + comments + linked PRs). */
    hydrate: (id: string) => Promise<Task>;
    /** Back to the task list. */
    onDone: () => void;
  }
  let {
    task,
    canEdit,
    canEditExtras,
    canEditWork,
    canDelete,
    canComment,
    linkedSessions,
    onStart,
    onOpenLink,
    onSetStatus,
    onResumeSession,
    onSave,
    onDelete,
    onComment,
    hydrate,
    onDone,
  }: Props = $props();

  // The description reuses the input bar / automation prompt editor so a task can
  // embed @files, /skills, #plans, and %docs. Refs round-trip through the saved
  // body markdown (serialized as `[title](plan://…)` links), so no separate ref
  // store is needed. The working directory + provider scope @-file search and the
  // slash menu to the task's project and the user's active agent.
  const session = getWorkspaceContext();
  const agentContext = getAgentContext();
  const editorProvider = $derived<AgentId>(
    (agentContext.activeMetadata?.id as AgentId) ?? "claude-code",
  );
  const editorCwd = $derived(session.tasksProjectCwd ?? undefined);

  // ── Shared chrome (mirrors AutomationBuilder's sidebar card system) ──
  // A hairline ring + soft lift floats each card; the title pairs micro-caps
  // with a rule that fades out.
  const CARD =
    "flex flex-col gap-2.5 p-3.5 rounded-[0.875rem] " +
    "border border-[color-mix(in_srgb,var(--solus-container-border)_55%,transparent)] " +
    "bg-(--solus-container-bg) shadow-[var(--solus-card-shadow-collapsed)]";
  const CARD_TITLE =
    "flex items-center gap-2.5 text-[0.625rem] font-semibold uppercase tracking-[0.09em] " +
    "text-(--solus-text-tertiary) after:content-[''] after:flex-1 after:h-px " +
    "after:bg-[linear-gradient(to_right,color-mix(in_srgb,var(--solus-container-border)_70%,transparent),transparent)]";
  const ROW = "flex items-center justify-between gap-3 min-h-[1.875rem]";
  const ROW_LABEL =
    "shrink-0 text-xs font-medium text-(--solus-text-secondary)";
  // Soft recessed full-width field (labels / branch / PR).
  const FIELD =
    "w-full text-xs text-(--solus-text-primary) bg-(--solus-surface-hover) rounded-lg px-2 py-[0.375rem] border-0 " +
    "[outline:0.0625rem_solid_transparent] transition-[background-color,outline-color] duration-120 " +
    "hover:bg-(--solus-accent-light) focus-visible:bg-[var(--solus-input-bg-soft,var(--solus-container-bg))] " +
    "focus-visible:[outline:0.125rem_solid_color-mix(in_srgb,var(--solus-accent)_55%,transparent)] placeholder:text-(--solus-text-tertiary)";
  // Borderless right-aligned value input for dense property rows.
  const GHOST_INPUT =
    "max-w-[9.5rem] text-xs text-right text-(--solus-text-primary) bg-transparent rounded-md px-1.5 py-1 border-0 " +
    "[outline:0.0625rem_solid_transparent] [color-scheme:light] [.dark_&]:[color-scheme:dark] transition-[background-color,outline-color] duration-120 " +
    "hover:bg-(--solus-surface-hover) focus-visible:bg-[var(--solus-input-bg-soft,var(--solus-container-bg))] " +
    "focus-visible:[outline-color:color-mix(in_srgb,var(--solus-accent)_55%,transparent)] placeholder:text-(--solus-text-tertiary)";
  // Ghost status trigger sitting in the Properties card.
  const GHOST_BTN =
    "inline-flex items-center gap-1.5 max-w-[9.5rem] text-xs text-(--solus-text-primary) bg-transparent rounded-md px-1.5 py-1 border-0 cursor-pointer " +
    "[outline:0.0625rem_solid_transparent] transition-[background-color] duration-120 hover:bg-(--solus-surface-hover) " +
    "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]";
  const ICON_BTN =
    "grid size-7 place-items-center rounded-lg border-0 bg-transparent text-(--solus-text-secondary) cursor-pointer " +
    "transition-colors duration-150 hover:bg-(--solus-accent-soft) hover:text-(--solus-accent) " +
    "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--solus-accent)";
  const CRUMB_LINK =
    "border-0 bg-transparent text-(--solus-text-tertiary) cursor-pointer px-1 py-0.5 rounded-md " +
    "transition-[color,background-color] duration-100 hover:text-(--solus-text-primary) hover:bg-(--solus-surface-hover) " +
    "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]";
  const START_BTN =
    "shrink-0 inline-flex items-center gap-1.5 px-3 py-[0.4375rem] rounded-lg border-0 text-xs font-semibold " +
    "text-[var(--solus-accent-contrast,#fff)] bg-(--solus-accent) cursor-pointer transition-[filter,opacity] duration-120 " +
    "hover:brightness-[1.07] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_55%,transparent)]";
  // Title + description mirror AutomationBuilder's main column: a borderless 2xl
  // title and a recessed markdown well that lifts on hover and outlines on focus.
  const TITLE_FIELD =
    "w-full text-2xl font-[650] tracking-[-0.02em] text-(--solus-text-primary) bg-transparent border-0 rounded-lg px-1 py-0.5 -ml-1 " +
    "[outline:0.0625rem_solid_transparent] transition-[outline-color,background-color] duration-120 placeholder:text-(--solus-text-tertiary) " +
    "hover:bg-(--solus-surface-hover) focus-visible:bg-[var(--solus-input-bg-soft,var(--solus-container-bg))] " +
    "focus-visible:[outline-color:color-mix(in_srgb,var(--solus-accent)_55%,transparent)]";
  // Wraps the markdown editor as one borderless field; the nested ProseMirror
  // keeps its own padding as the click target.
  const DESC_FIELD =
    "w-full rounded-[0.625rem] px-2 -mx-2 bg-transparent border-0 [outline:0.0625rem_solid_transparent] " +
    "transition-[background-color,outline-color] duration-120";
  const DESC_TEXT =
    "text-[0.8125rem] leading-[1.6] text-(--solus-text-secondary)";
  // Make the description editor stretch to fill the page: the wrapper, the inner
  // editor div and the ProseMirror surface all flex-grow so the writing area (and
  // its click target) runs the full available height rather than a fixed cap.
  const DESC_FILL =
    "flex-1 flex flex-col [&_.solus-doc-editor]:flex [&_.solus-doc-editor]:flex-1 [&_.solus-doc-editor]:flex-col [&_.ProseMirror]:flex-1";
  // Zero the ProseMirror left padding (the ~1.25rem gutter normally reserved for
  // the block drag handle, which tasks don't mount) so the description text lines
  // up flush with the title above it.
  const DESC_ALIGN = "[&_.ProseMirror]:!pl-0";
  // Shimmer placeholder for content that only arrives with hydration (body,
  // comments). Matches the app-wide skeleton-shimmer used elsewhere.
  const SKELETON_BAR =
    "rounded-[0.375rem] bg-[linear-gradient(90deg,var(--solus-surface-hover)_25%,transparent_50%,var(--solus-surface-hover)_75%)] [background-size:25rem_100%] animate-[skeleton-shimmer_1.5s_ease-in-out_infinite]";
  const markdownRenderers = {
    code: CodeBlock,
    codespan: TaskCommentCodeSpan,
    link: MarkdownLink,
  };

  // Render the list summary immediately, overlaying the hydrated copy (full body,
  // comments, linked PRs) once it arrives so the page never blocks. `display`
  // derives from the prop so a re-opened detail stays in sync; `hydrated` is the
  // overlay we fill in and also write edits/status into.
  let hydrated = $state<Task | null>(null);
  const display = $derived<Task>(hydrated ?? task);
  let hydrating = $state(true);

  const hydration = $derived(taskHydration(display));
  const comments = $derived<TaskComment[]>(hydration.comments);
  const linkedPrs = $derived<TaskLinkedPr[]>(hydration.linkedPrs);

  // Inline edit buffers. Seeded once from the summary; auto-save commits each
  // field on blur/change — no separate edit mode (Linear-style). `untrack` makes
  // the one-time snapshot explicit; TasksPage keys this page on the task id so
  // switching tasks remounts with fresh drafts.
  const initial = untrack(() => task);
  let titleDraft = $state(initial.title);
  let bodyDraft = $state(initial.body);
  let bodyEditorEl: ReturnType<typeof DocumentPromptEditor> | null =
    $state(null);
  // Blank add-field: existing labels live in their chips, this only appends new ones.
  let labelDraft = $state("");
  let dueDateDraft = $state(initial.dueDate ?? "");
  let priorityDraft = $state<TaskPriority | "">(initial.priority ?? "");
  let branchDraft = $state(initial.branch ?? "");
  let prDraft = $state(initial.pr?.url ?? "");
  const PRIORITY_OPTIONS: TaskPriority[] = ["urgent", "high", "medium", "low"];
  const prioritySelectOptions: { value: TaskPriority | ""; label: string }[] = [
    { value: "", label: "No priority" },
    ...PRIORITY_OPTIONS.map((p) => ({
      value: p,
      label: PRIORITY_META[p].label,
    })),
  ];

  // Body is the one field that only arrives with hydration, so re-seed it once
  // the full ticket lands — unless the user is already editing it.
  const initialBody = initial.body;
  let bodyFocused = $state(false);
  let bodySeeded = false;
  $effect(() => {
    const h = hydrated;
    if (h && !bodySeeded && !bodyFocused && bodyDraft === initialBody) {
      bodyDraft = h.body;
      bodySeeded = true;
    }
  });

  const due = $derived(
    display.status === "done" ? null : dueDateMeta(display.dueDate),
  );
  const dueToneClass = $derived(
    due?.tone === "overdue"
      ? "text-[#f85149]"
      : due?.tone === "soon"
        ? "text-[#d29922]"
        : "text-(--solus-text-tertiary)",
  );

  let commentDraft = $state("");
  let posting = $state(false);

  let statusMenuOpen = $state(false);
  let statusTriggerEl = $state<HTMLButtonElement | null>(null);
  const STATUS_OPTIONS: TaskStatus[] = ["open", "in_progress", "done"];

  $effect(() => {
    let cancelled = false;
    hydrating = true;
    void hydrate(task.id)
      .then((t) => {
        if (!cancelled) hydrated = t;
      })
      .catch(() => {
        // Keep the summary view; hydration is best-effort.
      })
      .finally(() => {
        if (!cancelled) hydrating = false;
      });
    return () => {
      cancelled = true;
    };
  });

  // Manual re-pull of the full ticket (body + comments + linked PRs). Guarded so
  // it never races the initial hydration or a prior in-flight refresh.
  async function refresh() {
    if (hydrating) return;
    hydrating = true;
    try {
      hydrated = await hydrate(task.id);
    } catch {
      // Keep the current view; refresh is best-effort.
    } finally {
      hydrating = false;
    }
  }

  // ── Save status (mirrors DocumentShell auto-save) ──
  // A pulsing dot + "Saving…" while a field write is in flight, then a check +
  // self-refreshing "Last saved …". `savedStatusNow` is ticked on an interval so
  // the relative timestamp stays current without an edit.
  let isSaving = $state(false);
  let lastSavedAt = $state<number | null>(null);
  let savedStatusNow = $state(Date.now());
  $effect(() => {
    if (lastSavedAt === null) return;
    const interval = setInterval(() => {
      savedStatusNow = Date.now();
    }, 10_000);
    return () => clearInterval(interval);
  });

  // ── Per-field auto-save ──
  // `patch` carries the provider clear-sentinels ("" → unset); `local` is the
  // resolved value we mirror into `hydrated` optimistically before reconciling
  // with the provider's post-write truth.
  async function commit(patch: Partial<Task>, local: Partial<Task>) {
    const prev = hydrated;
    hydrated = { ...display, ...local };
    isSaving = true;
    try {
      hydrated = await onSave(patch);
      lastSavedAt = Date.now();
      savedStatusNow = lastSavedAt;
    } catch {
      // Parent surfaces a toast; revert the optimistic display but keep the draft
      // so the user can retry.
      hydrated = prev;
    } finally {
      isSaving = false;
    }
  }

  function commitTitle() {
    const title = titleDraft.trim() || display.title;
    titleDraft = title;
    if (title !== display.title) void commit({ title }, { title });
  }
  function commitBody() {
    bodyFocused = false;
    // The editor emits markdown debounced; pull the live content on blur so the
    // last keystrokes aren't lost before the commit comparison.
    bodyDraft = bodyEditorEl?.getMarkdown() ?? bodyDraft;
    if (bodyDraft !== display.body)
      void commit({ body: bodyDraft }, { body: bodyDraft });
  }
  function addLabels() {
    const added = labelDraft
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean);
    labelDraft = "";
    if (!added.length) return;
    const labels = [...display.labels];
    for (const l of added) if (!labels.includes(l)) labels.push(l);
    if (labels.join(" ") !== display.labels.join(" "))
      void commit({ labels }, { labels });
  }
  function removeLabel(label: string) {
    const labels = display.labels.filter((l) => l !== label);
    void commit({ labels }, { labels });
  }
  function commitDueDate() {
    const dueDate = dueDateDraft || undefined;
    if ((dueDate ?? "") !== (display.dueDate ?? ""))
      void commit({ dueDate: dueDateDraft || "" }, { dueDate });
  }
  function commitPriority(p: TaskPriority | "") {
    priorityDraft = p;
    const priority = p || undefined;
    if (priority !== display.priority)
      void commit({ priority: p as TaskPriority }, { priority });
  }
  function commitBranch() {
    const branch = branchDraft.trim() || undefined;
    if ((branch ?? "") !== (display.branch ?? ""))
      void commit({ branch: branchDraft.trim() || "" }, { branch });
  }
  function commitPr() {
    const pr = taskPrFromUrl(prDraft.trim());
    if ((pr?.url ?? "") !== (display.pr?.url ?? ""))
      void commit({ pr: pr ?? undefined }, { pr });
  }

  async function postComment() {
    const body = commentDraft.trim();
    if (!body || posting) return;
    posting = true;
    try {
      hydrated = await onComment(body);
      commentDraft = "";
    } finally {
      posting = false;
    }
  }

  const prStateColor = (s: TaskLinkedPr["state"]) =>
    s === "MERGED"
      ? "text-[#a371f7]"
      : s === "CLOSED"
        ? "text-[#f85149]"
        : "text-[#3fb950]";
</script>

<div
  class="task-detail-scroll flex flex-1 min-h-0 flex-col overflow-y-auto pt-4 px-5 pb-10 overscroll-y-contain"
>
  <article
    class="max-w-[92rem] w-full mx-auto flex flex-col gap-6 min-h-full"
  >
    <!-- ── Breadcrumb header + actions ── -->
    <header class="flex items-center justify-between gap-4">
      <nav
        class="flex min-w-0 items-center gap-1.5 text-[0.8125rem]"
        aria-label="Breadcrumb"
      >
        <button type="button" class={CRUMB_LINK} onclick={onDone}>Tasks</button>
        <CaretRightIcon
          size={12}
          class="text-(--solus-text-tertiary) opacity-60 shrink-0"
        />
        <span class="text-(--solus-text-tertiary) tabular-nums shrink-0"
          >{display.id.length > 8
            ? `#${display.id.slice(0, 6)}`
            : `#${display.id}`}</span
        >
        {#if hydrating}
          <CircleNotchIcon
            size={12}
            class="animate-spin text-(--solus-text-tertiary) [animation-duration:0.9s] shrink-0"
          />
        {/if}
        {#if isSaving || lastSavedAt !== null}
          <span
            class="shrink-0 pl-1.5 border-l border-[color-mix(in_srgb,var(--solus-container-border)_55%,transparent)]"
          >
            <span
              class="inline-flex items-center gap-[0.3125rem] whitespace-nowrap text-[0.6875rem] text-(--solus-text-tertiary) select-none"
              aria-live="polite"
              role="status"
            >
              {#if isSaving}
                <span
                  class="size-1.5 shrink-0 rounded-full bg-(--solus-accent) animate-pulse"
                  aria-hidden="true"
                ></span>
                <span>Saving…</span>
              {:else if lastSavedAt !== null}
                <CheckIcon size={11} />
                <span>{formatSavedAgo(lastSavedAt, savedStatusNow)}</span>
              {/if}
            </span>
          </span>
        {/if}
      </nav>
      <div class="flex shrink-0 items-center gap-1">
        <button
          type="button"
          class="{ICON_BTN} disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-(--solus-text-secondary)"
          onclick={refresh}
          disabled={hydrating}
          aria-label="Refresh task"
          title="Refresh"
        >
          <ArrowsClockwiseIcon
            size={15}
            class={hydrating ? "animate-spin [animation-duration:0.9s]" : ""}
          />
        </button>
        {#if display.url}
          <button
            type="button"
            class={ICON_BTN}
            onclick={() => onOpenLink(display)}
            aria-label="Open source ticket"
            title="Open in browser"
          >
            <ArrowSquareOutIcon size={15} />
          </button>
        {/if}
        {#if canDelete}
          <button
            type="button"
            class="grid size-7 place-items-center rounded-lg border-0 bg-transparent text-(--solus-text-secondary) cursor-pointer transition-colors duration-150 hover:bg-[#f85149]/12 hover:text-[#f85149] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#f85149]"
            onclick={() => onDelete(display)}
            aria-label="Delete task"
            title="Delete"
          >
            <TrashIcon size={15} />
          </button>
        {/if}
        <button
          type="button"
          class={START_BTN}
          onclick={() => onStart(display)}
        >
          <PlayIcon size={13} weight="fill" />
          <span>Start session</span>
        </button>
      </div>
    </header>

    <!-- ── Two columns: main content + properties sidebar ── -->
    <div
      class="grid grid-cols-[minmax(0,1fr)_minmax(14rem,18rem)] gap-8 @min-[92rem]:gap-10 @max-[52rem]:grid-cols-1 @max-[52rem]:gap-6 flex-1"
    >
      <!-- ── Main ── -->
      <section class="flex flex-col gap-4 min-w-0">
        {#if canEdit}
          <input
            bind:value={titleDraft}
            onblur={commitTitle}
            type="text"
            aria-label="Task title"
            placeholder="Task title"
            class={TITLE_FIELD}
          />
        {:else}
          <h2
            class="text-2xl font-[650] tracking-[-0.02em] text-(--solus-text-primary) {display.status ===
            'done'
              ? 'line-through opacity-70'
              : ''}"
          >
            {display.title}
          </h2>
        {/if}

        <!-- Description -->
        <div class="flex flex-1 flex-col">
          {#if canEdit}
            <div class="{DESC_FIELD} flex flex-1 flex-col">
              <DocumentPromptEditor
                bind:this={bodyEditorEl}
                value={bodyDraft}
                onValueChange={(v) => (bodyDraft = v)}
                onFocus={() => (bodyFocused = true)}
                onBlur={commitBody}
                pluginCommands={session.pluginCommands}
                provider={editorProvider}
                workingDirectory={editorCwd}
                onPlanRefClick={(planId) => session.openPlanModal(planId)}
                onWorkRefClick={(workId, title) =>
                  session.openWorkModal(workId, title)}
                menuPlacement="down"
                dragHandle={false}
                placeholder="Add a description… Use @ for files, # for plans, % for docs, / to format."
                class="{DESC_TEXT} {DESC_FILL} {DESC_ALIGN}"
              />
            </div>
          {:else if display.body.trim()}
            <DocumentPromptEditor
              value={display.body}
              onValueChange={() => {}}
              readOnly
              dragHandle={false}
              pluginCommands={session.pluginCommands}
              provider={editorProvider}
              workingDirectory={editorCwd}
              onPlanRefClick={(planId) => session.openPlanModal(planId)}
              onWorkRefClick={(workId, title) =>
                session.openWorkModal(workId, title)}
              maxHeight={4000}
              class="{DESC_TEXT} {DESC_ALIGN}"
            />
          {:else if hydrating}
            <div
              class="flex flex-col gap-2"
              aria-busy="true"
              aria-label="Loading description"
            >
              <div class="{SKELETON_BAR} h-3" style="width:92%"></div>
              <div class="{SKELETON_BAR} h-3" style="width:78%"></div>
              <div class="{SKELETON_BAR} h-3" style="width:64%"></div>
            </div>
          {:else}
            <p class="text-[0.8125rem] italic text-(--solus-text-tertiary)">
              No description.
            </p>
          {/if}
        </div>

        <!-- Linked PRs -->
        {#if linkedPrs.length}
          <div>
            <h3
              class="mb-1.5 text-[0.6875rem] font-semibold uppercase tracking-wide text-(--solus-text-tertiary)"
            >
              Linked pull requests
            </h3>
            <ul class="flex flex-col gap-1" role="list">
              {#each linkedPrs as pr (pr.number)}
                <li>
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 rounded-md border-0 bg-transparent px-1.5 py-1 text-left cursor-pointer hover:bg-(--solus-surface-hover)"
                    onclick={() => window.solus.openExternal(pr.url)}
                  >
                    <GitPullRequestIcon
                      size={13}
                      class={prStateColor(pr.state)}
                    />
                    <span
                      class="truncate text-[0.75rem] text-(--solus-text-secondary)"
                      >{pr.title}</span
                    >
                    <span
                      class="ml-auto shrink-0 text-[0.6875rem] text-(--solus-text-tertiary) tabular-nums"
                      >#{pr.number}</span
                    >
                  </button>
                </li>
              {/each}
            </ul>
          </div>
        {/if}

        <!-- Active sessions (back-link) -->
        {#if linkedSessions.length}
          <div>
            <h3
              class="mb-1.5 text-[0.6875rem] font-semibold uppercase tracking-wide text-(--solus-text-tertiary)"
            >
              Sessions on this task
            </h3>
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-md border-0 bg-(--solus-accent-light) px-2 py-1.5 text-left cursor-pointer hover:bg-[color-mix(in_srgb,var(--solus-accent-light)_100%,var(--solus-accent)_14%)]"
              onclick={() => onResumeSession(display)}
            >
              <ChatCircleDotsIcon size={14} class="text-(--solus-accent)" />
              <span class="text-[0.75rem] font-medium text-(--solus-accent)"
                >Open the latest session</span
              >
              <span
                class="ml-auto text-[0.6875rem] text-(--solus-accent) opacity-70"
                >{linkedSessions.length} linked</span
              >
            </button>
          </div>
        {/if}

        <!-- Comments -->
        {#if comments.length || canComment}
          <div>
            <h3
              class="mb-1.5 text-[0.6875rem] font-semibold uppercase tracking-wide text-(--solus-text-tertiary)"
            >
              Comments
            </h3>
            {#if !comments.length && hydrating}
              <ul
                class="flex flex-col gap-2.5"
                role="list"
                aria-busy="true"
                aria-label="Loading comments"
              >
                {#each [88, 72] as bodyWidth (bodyWidth)}
                  <li
                    class="rounded-[0.875rem] border border-[color-mix(in_srgb,var(--solus-container-border)_60%,transparent)] bg-(--solus-container-bg) px-3.5 py-3"
                  >
                    <div class="flex items-center gap-2">
                      <span class="{SKELETON_BAR} size-6 shrink-0 rounded-full"
                      ></span>
                      <span class="{SKELETON_BAR} h-2.5 w-24"></span>
                    </div>
                    <div class="mt-2.5 flex flex-col gap-1.5">
                      <span
                        class="{SKELETON_BAR} h-2.5"
                        style="width:{bodyWidth}%"
                      ></span>
                      <span
                        class="{SKELETON_BAR} h-2.5"
                        style="width:{bodyWidth - 30}%"
                      ></span>
                    </div>
                  </li>
                {/each}
              </ul>
            {/if}
            {#if comments.length}
              <ul class="flex flex-col gap-2.5" role="list">
                {#each comments as c, i (i)}
                  <li
                    class="rounded-[0.875rem] border border-[color-mix(in_srgb,var(--solus-container-border)_60%,transparent)] bg-(--solus-container-bg) px-3.5 py-3"
                  >
                    <div class="flex items-center gap-2">
                      <span
                        class="grid size-6 shrink-0 place-items-center rounded-full bg-(--solus-accent) text-[0.625rem] font-semibold text-[var(--solus-accent-contrast,#fff)] outline-1 -outline-offset-1 outline-black/5 select-none"
                        aria-hidden="true"
                      >
                        {authorInitials(c.author?.login)}
                      </span>
                      <span
                        class="text-[0.8125rem] font-semibold text-(--solus-text-primary)"
                        >{c.author?.login ?? "unknown"}</span
                      >
                      <span class="text-xs text-(--solus-text-tertiary)"
                        >{relativeTime(c.createdAt)}</span
                      >
                    </div>
                    <div
                      class="prose-cloud mt-1.5 text-[0.8125rem] leading-[1.55] text-(--solus-text-secondary) [--solus-font-weight-body:400]"
                    >
                      <SvelteMarkdown
                        source={c.body}
                        renderers={markdownRenderers}
                        sanitizeUrl={markdownSanitizeUrl}
                      />
                    </div>
                  </li>
                {/each}
              </ul>
            {/if}

            {#if canComment}
              <div
                class="mt-3 flex flex-col rounded-xl border border-(--solus-container-border) bg-transparent transition-colors duration-150 focus-within:border-(--solus-accent)"
              >
                <div class="px-3">
                  <PromptEditor
                    value={commentDraft}
                    onValueChange={(v) => (commentDraft = v)}
                    enterInsertsNewline
                    disabled={posting}
                    pluginCommands={session.pluginCommands}
                    provider={editorProvider}
                    workingDirectory={editorCwd}
                    onPlanRefClick={(planId) => session.openPlanModal(planId)}
                    onWorkRefClick={(workId, title) =>
                      session.openWorkModal(workId, title)}
                    menuPlacement="down"
                    maxHeight={200}
                    placeholder="Add a comment…"
                    class={DESC_TEXT}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        e.stopPropagation();
                        void postComment();
                      }
                    }}
                  />
                </div>
                <div class="flex items-center justify-end gap-2 px-2.5 pb-2">
                  <span
                    class="mr-auto pl-1 text-[0.6875rem] text-(--solus-text-tertiary) @max-[30rem]:hidden"
                  >
                    <kbd class="font-sans">⌘</kbd><kbd class="font-sans">↵</kbd>
                    to send
                  </span>
                  <button
                    type="button"
                    class="inline-flex items-center gap-1.5 rounded-lg border-0 bg-(--solus-accent) px-3 py-[0.3125rem] text-[0.75rem] font-semibold text-[var(--solus-accent-contrast,#fff)] cursor-pointer transition-[filter,opacity] duration-120 hover:brightness-[1.07] disabled:cursor-not-allowed disabled:opacity-40"
                    onclick={postComment}
                    disabled={!commentDraft.trim() || posting}
                    title="Post comment (⌘↵)"
                  >
                    {#if posting}
                      <CircleNotchIcon
                        size={12}
                        class="animate-spin [animation-duration:0.7s]"
                      />
                      Posting…
                    {:else}
                      Comment
                    {/if}
                  </button>
                </div>
              </div>
            {/if}
          </div>
        {/if}
      </section>

      <!-- ── Properties sidebar ── -->
      <aside class="flex flex-col gap-3.5 min-w-0 @max-[52rem]:order-first">
        <!-- Properties -->
        <section class={CARD}>
          <h2 class={CARD_TITLE}>Properties</h2>
          <dl class="flex flex-col gap-0.5 [&_dt]:m-0 [&_dd]:m-0">
            <div class={ROW}>
              <dt class={ROW_LABEL}>Status</dt>
              <dd>
                <button
                  type="button"
                  bind:this={statusTriggerEl}
                  class={GHOST_BTN}
                  aria-haspopup="listbox"
                  aria-expanded={statusMenuOpen}
                  onclick={() => (statusMenuOpen = !statusMenuOpen)}
                >
                  <span
                    class="block size-2 rounded-full {STATUS_META[
                      display.status
                    ].dotClass}"
                  ></span>
                  <span class="truncate">{statusLabel(display.status)}</span>
                  <CaretDownIcon
                    size={11}
                    class="text-(--solus-text-tertiary)"
                  />
                </button>
                <Dropdown
                  bind:open={statusMenuOpen}
                  triggerEl={statusTriggerEl}
                  align="bottom"
                  anchor="right"
                  width={160}
                >
                  <div class="py-1" role="listbox" aria-label="Set status">
                    {#each STATUS_OPTIONS as opt (opt)}
                      <DropdownItem
                        selected={display.status === opt}
                        onclick={() => {
                          statusMenuOpen = false;
                          if (display.status !== opt) {
                            onSetStatus(display, opt);
                            hydrated = { ...display, status: opt };
                          }
                        }}
                      >
                        <span class="flex items-center gap-2">
                          <span
                            class="block size-2 rounded-full {STATUS_META[opt]
                              .dotClass}"
                          ></span>
                          {STATUS_META[opt].label}
                        </span>
                      </DropdownItem>
                    {/each}
                  </div>
                </Dropdown>
              </dd>
            </div>

            <div class={ROW}>
              <dt class={ROW_LABEL}>Priority</dt>
              <dd>
                {#if canEditExtras}
                  <Select
                    value={priorityDraft}
                    options={prioritySelectOptions}
                    onChange={commitPriority}
                    ariaLabel="Priority"
                    anchor="right"
                    variant="ghost"
                  />
                {:else if display.priority}
                  <span
                    class="text-xs font-medium {PRIORITY_META[display.priority]
                      .flagClass}">{PRIORITY_META[display.priority].label}</span
                  >
                {:else}
                  <span class="text-xs text-(--solus-text-tertiary)">—</span>
                {/if}
              </dd>
            </div>

            <div class={ROW}>
              <dt class={ROW_LABEL}>Due</dt>
              <dd class="min-w-0">
                {#if canEditExtras}
                  <input
                    bind:value={dueDateDraft}
                    onchange={commitDueDate}
                    type="date"
                    aria-label="Due date"
                    class={GHOST_INPUT}
                  />
                {:else if due}
                  <span
                    class="inline-flex items-center gap-1 text-xs font-medium tabular-nums {dueToneClass}"
                  >
                    <CalendarBlankIcon size={11} weight="bold" />
                    {due.label}
                  </span>
                {:else}
                  <span class="text-xs text-(--solus-text-tertiary)">—</span>
                {/if}
              </dd>
            </div>
          </dl>
        </section>

        <!-- Labels -->
        {#if canEdit || display.labels.length}
          <section class={CARD}>
            <h2 class={CARD_TITLE}>Labels</h2>
            {#if display.labels.length}
              <div class="flex flex-wrap gap-1.5">
                {#each display.labels as label (label)}
                  <span
                    class="inline-flex items-center gap-1 rounded-md bg-(--solus-surface-hover) px-1.5 py-0.5 text-[0.625rem] font-medium leading-none text-(--solus-text-secondary)"
                  >
                    <span
                      class="size-1 shrink-0 rounded-full bg-(--solus-text-tertiary)"
                    ></span>
                    {label}
                    {#if canEdit}
                      <button
                        type="button"
                        class="grid size-3 place-items-center rounded-sm border-0 bg-transparent text-(--solus-text-tertiary) cursor-pointer hover:text-(--solus-text-primary)"
                        onclick={() => removeLabel(label)}
                        aria-label={`Remove ${label}`}
                      >
                        <XIcon size={9} weight="bold" />
                      </button>
                    {/if}
                  </span>
                {/each}
              </div>
            {/if}
            {#if canEdit}
              <input
                bind:value={labelDraft}
                onblur={addLabels}
                onkeydown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addLabels();
                  }
                }}
                type="text"
                placeholder="Add a label…"
                aria-label="Add a label"
                class={FIELD}
              />
            {/if}
          </section>
        {/if}

        <!-- Git -->
        {#if canEditWork || display.branch || display.pr}
          <section class={CARD}>
            <h2 class={CARD_TITLE}>Git</h2>
            {#if canEditWork}
              <label
                class="flex flex-col gap-1 text-[0.6875rem] font-medium text-(--solus-text-tertiary)"
              >
                Branch
                <input
                  bind:value={branchDraft}
                  onblur={commitBranch}
                  type="text"
                  placeholder="feature/my-branch"
                  class="{FIELD} font-mono"
                />
              </label>
              <label
                class="flex flex-col gap-1 text-[0.6875rem] font-medium text-(--solus-text-tertiary)"
              >
                Pull request URL
                <input
                  bind:value={prDraft}
                  onblur={commitPr}
                  type="url"
                  placeholder="https://github.com/owner/repo/pull/123"
                  class={FIELD}
                />
              </label>
            {:else}
              <div class="flex flex-wrap items-center gap-1.5">
                {#if display.pr}
                  <button
                    type="button"
                    class="inline-flex items-center gap-1 rounded-md bg-(--solus-accent-light) px-1.5 py-0.5 text-[0.625rem] font-medium leading-none text-(--solus-accent) tabular-nums cursor-pointer hover:bg-[color-mix(in_srgb,var(--solus-accent-light)_100%,var(--solus-accent)_14%)]"
                    onclick={() =>
                      display.pr && window.solus.openExternal(display.pr.url)}
                    title={display.pr.url}
                  >
                    <GitPullRequestIcon size={11} weight="bold" />
                    {display.pr.number ? `PR #${display.pr.number}` : "PR"}
                  </button>
                {/if}
                {#if display.branch}
                  <span
                    class="inline-flex max-w-full items-center gap-1 rounded-md bg-(--solus-surface-hover) px-1.5 py-0.5 font-mono text-[0.625rem] font-medium leading-none text-(--solus-text-tertiary)"
                    title={display.branch}
                  >
                    <GitBranchIcon size={11} weight="bold" />
                    <span class="truncate">{display.branch}</span>
                  </span>
                {/if}
              </div>
            {/if}
          </section>
        {/if}
      </aside>
    </div>
  </article>
</div>

<style>
  .task-detail-scroll {
    scrollbar-width: thin;
    scrollbar-color: transparent transparent;
    transition: scrollbar-color var(--duration-base) var(--ease-premium);
  }

  .task-detail-scroll:hover,
  .task-detail-scroll:focus-within {
    scrollbar-color: var(--solus-scroll-thumb) transparent;
  }

  .task-detail-scroll::-webkit-scrollbar-thumb {
    background: transparent;
    transition: background var(--duration-base) var(--ease-premium);
  }

  .task-detail-scroll:hover::-webkit-scrollbar-thumb,
  .task-detail-scroll:focus-within::-webkit-scrollbar-thumb {
    background: var(--solus-scroll-thumb);
  }

  .task-detail-scroll::-webkit-scrollbar-thumb:hover {
    background: var(--solus-scroll-thumb-hover);
  }
</style>
