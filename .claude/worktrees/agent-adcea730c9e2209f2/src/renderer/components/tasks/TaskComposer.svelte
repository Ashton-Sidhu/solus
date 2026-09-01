<script lang="ts">
  import { tick, untrack } from "svelte";
  import {
    StackIcon,
    CheckSquareIcon,
    XIcon,
    CircleNotchIcon,
    CalendarBlankIcon,
    FlagIcon,
    CheckIcon,
    TagIcon,
    ArrowsOutSimpleIcon,
    ArrowsInSimpleIcon,
  } from "phosphor-svelte";
  import Kbd from "../ui/Kbd.svelte";
  import Dropdown from "../ui/Dropdown.svelte";
  import PromptEditor from "../ui/PromptEditor.svelte";
  import { Input } from "../ui/input";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import type { AgentId } from "../../../shared/types";
  import { PRIORITY_META, STATUS_META, dueDateMeta } from "./lib/tasks-api";
  import {
    loadDraft,
    saveDraft,
    clearDraft,
    loadCreateAnother,
    saveCreateAnother,
    dueDatePresets,
    pickerKeydown,
    focusFirstItem,
    addLabel,
    labelSuggestions,
  } from "./lib/task-composer";
  import type {
    Task,
    TaskKind,
    TaskPriority,
    TaskStatus,
  } from "../../../shared/task-types";

  interface Props {
    /** Existing epics, offered as the parent for a new task. */
    epics: Task[];
    /** Whether the provider models epics/sub-tasks + a settable status (local
     *  only). When false the composer hides those local-only fields. */
    allowEpics?: boolean;
    /** Whether priority/due date will actually persist on create. A new GitHub
     *  issue isn't on a Projects board yet, so those fields would be silently
     *  dropped — hide them rather than eat the input. */
    canPlan?: boolean;
    /** Known project labels, offered as suggestions in the labels picker. */
    knownLabels?: string[];
    /** Project directory for @-file / #-plan / %-work autocomplete in the body. */
    workingDirectory?: string;
    /** Agent provider whose built-in slash commands populate the body's / menu. */
    provider: AgentId;
    /** Preset parent (when adding a child from an epic header). Locks to a task. */
    initialParentId?: string;
    /** Preset status (when adding into a board column). */
    initialStatus?: TaskStatus;
    /** Performs the write. Throws on failure (the caller surfaces a toast); on
     *  success the composer owns dismissal (so "Create more" can stay open). */
    onCreate: (input: {
      title: string;
      body: string;
      kind: TaskKind;
      parentId?: string;
      dueDate?: string;
      priority?: TaskPriority;
      status?: TaskStatus;
      labels?: string[];
    }) => Promise<void> | void;
    onCancel: () => void;
  }
  let {
    epics,
    allowEpics = false,
    canPlan = false,
    knownLabels = [],
    workingDirectory,
    provider,
    initialParentId,
    initialStatus,
    onCreate,
    onCancel,
  }: Props = $props();

  const session = getWorkspaceContext();

  // Only the plain "new task" composer restores and persists a draft — a preset
  // parent (add-from-epic) or preset status (add-into-column) is its own flow
  // and must neither resurrect nor overwrite the plain draft.
  const persistable = untrack(() => !initialParentId && !initialStatus);
  const draft = persistable ? loadDraft() : null;

  let title = $state(draft?.title ?? "");
  let body = $state(draft?.body ?? "");
  // ISO calendar day (YYYY-MM-DD), empty when unset.
  let dueDate = $state(draft?.dueDate ?? "");
  let priority = $state<TaskPriority | "">(draft?.priority ?? "");
  let status = $state<TaskStatus>(
    untrack(() => initialStatus) ?? draft?.status ?? "open",
  );
  let labels = $state<string[]>(draft?.labels ?? []);
  // A preset parent forces a child task; otherwise the user chooses task vs epic.
  let kind = $state<TaskKind>(draft?.kind ?? "task");
  let parentId = $state(draft?.parentId ?? "");
  let createAnother = $state(loadCreateAnother());

  const PRIORITY_OPTIONS: TaskPriority[] = ["urgent", "high", "medium", "low"];
  const STATUS_OPTIONS: TaskStatus[] = ["open", "in_progress", "done"];
  const presets = dueDatePresets();

  let titleEl = $state<HTMLInputElement | null>(null);
  let labelInputEl = $state<HTMLInputElement | null>(null);
  let labelDraft = $state("");
  // In-flight write — drives the button spinner and blocks double-submits.
  let saving = $state(false);
  // Expanded layout: a wider modal with a taller description editor for writing
  // longer task bodies. Toggled from the header or with ⌥F.
  let expanded = $state(false);

  // Focus the title on the next frame, not just the next microtask. When the
  // composer is opened from the command palette it mounts in the same tick the
  // palette tears down, and a microtask-timed focus loses to the browser moving
  // focus to <body> as the palette's search input is removed. rAF lands the
  // focus after that teardown settles. (Same reason MarkdownEditor.focus() and
  // the input bar reach for rAF on a visibility transition.)
  $effect(() => {
    const raf = requestAnimationFrame(() =>
      titleEl?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(raf);
  });

  // Persist the draft on every edit so closing without saving doesn't lose it.
  $effect(() => {
    if (!persistable) return;
    saveDraft({
      title,
      body,
      dueDate,
      priority,
      status,
      kind,
      parentId,
      labels,
    });
  });

  const parentEpic = $derived(
    initialParentId
      ? epics.find((e) => e.id === initialParentId)
      : parentId
        ? epics.find((e) => e.id === parentId)
        : undefined,
  );
  const heading = $derived(
    initialParentId
      ? "New sub-task"
      : kind === "epic"
        ? "New epic"
        : "New task",
  );
  const dueLabel = $derived(
    dueDate ? (dueDateMeta(dueDate)?.label ?? dueDate) : null,
  );
  const suggestions = $derived(
    labelSuggestions(knownLabels, labels, labelDraft),
  );
  const canSubmit = $derived(title.trim().length > 0 && !saving);

  // ── Property pickers (Linear-style popovers) ──────────────────────────────
  type PickerName = "status" | "priority" | "due" | "labels" | "parent";
  let statusOpen = $state(false);
  let priorityOpen = $state(false);
  let dueOpen = $state(false);
  let labelsOpen = $state(false);
  let parentOpen = $state(false);
  let statusTrigger = $state<HTMLButtonElement | null>(null);
  let priorityTrigger = $state<HTMLButtonElement | null>(null);
  let dueTrigger = $state<HTMLButtonElement | null>(null);
  let labelsTrigger = $state<HTMLButtonElement | null>(null);
  let parentTrigger = $state<HTMLButtonElement | null>(null);
  let statusPanel = $state<HTMLDivElement | null>(null);
  let priorityPanel = $state<HTMLDivElement | null>(null);
  let duePanel = $state<HTMLDivElement | null>(null);
  let parentPanel = $state<HTMLDivElement | null>(null);

  function closePickers() {
    statusOpen = priorityOpen = dueOpen = labelsOpen = parentOpen = false;
  }

  function openPicker(name: PickerName) {
    statusOpen = name === "status";
    priorityOpen = name === "priority";
    dueOpen = name === "due";
    labelsOpen = name === "labels";
    parentOpen = name === "parent";
    void tick().then(() => {
      if (name === "labels") labelInputEl?.focus();
      else
        focusFirstItem(
          name === "status"
            ? statusPanel
            : name === "priority"
              ? priorityPanel
              : name === "due"
                ? duePanel
                : parentPanel,
        );
    });
  }

  function togglePicker(name: PickerName, isOpen: boolean) {
    if (isOpen) closePickers();
    else openPicker(name);
  }

  /** Apply a property choice, close the popover, and return focus to the title so
   *  the user can keep typing (per the keyboard-first flow). */
  function commit(apply: () => void) {
    apply();
    closePickers();
    void tick().then(() => titleEl?.focus());
  }

  function addLabelFromInput() {
    labels = addLabel(labels, labelDraft);
    labelDraft = "";
    labelInputEl?.focus();
  }

  function removeLabel(label: string) {
    labels = labels.filter((l) => l !== label);
  }

  async function submit() {
    if (!canSubmit) return;
    // A preset parent (adding from an epic header) always wins and forces a task;
    // otherwise epics never nest and a task takes the chosen parent, if any.
    const parent = initialParentId ?? (kind === "task" ? parentId : "");
    saving = true;
    try {
      await onCreate({
        title: title.trim(),
        body: body.trim(),
        kind: initialParentId ? "task" : kind,
        parentId: parent || undefined,
        // Planning fields only persist where the provider stores them (local).
        dueDate: canPlan ? dueDate || undefined : undefined,
        priority: canPlan ? priority || undefined : undefined,
        // Status is only a real settable field locally; GitHub issues open as open.
        status: allowEpics ? status : undefined,
        labels: labels.length ? [...labels] : undefined,
      });
    } catch {
      // The caller showed a toast; keep the modal + draft so the user can retry.
      saving = false;
      return;
    }
    clearDraft();
    saving = false;
    if (createAnother) resetForAnother();
    else onCancel();
  }

  /** Rapid-entry reset: clear the content fields but keep the chosen properties
   *  (status/priority/due/kind/parent) so a run of similar tasks is fast. */
  function resetForAnother() {
    title = "";
    body = "";
    labels = [];
    labelDraft = "";
    closePickers();
    void tick().then(() => titleEl?.focus());
  }

  function toggleCreateAnother() {
    createAnother = !createAnother;
    saveCreateAnother(createAnother);
  }

  // Handle keys at the panel level and stop propagation so Escape doesn't bubble
  // to the Tasks page's `tasks.close` binding and tear down the whole view. When a
  // picker is open the Dropdown's own Escape handler closes it first.
  function onPanelKeydown(e: KeyboardEvent) {
    // An open autocomplete menu in the body consumes its keys (e.g. Escape to
    // close the menu) via preventDefault but the event still bubbles here —
    // don't let that Escape tear down the whole modal.
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (!saving) onCancel();
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      void submit();
      return;
    }
    // ⌥-letter accelerators open the matching picker (e.code is keyboard-layout
    // independent, so opt-S resolves even though macOS maps opt-S to "ß").
    if (e.altKey && !e.metaKey && !e.ctrlKey && !saving) {
      const map: Record<string, PickerName> = {
        KeyS: "status",
        KeyP: "priority",
        KeyD: "due",
        KeyL: "labels",
      };
      const name = map[e.code];
      const nameAllowed =
        name === "status"
          ? allowEpics
          : name === "priority" || name === "due"
            ? canPlan
            : !!name;
      if (name && nameAllowed) {
        e.preventDefault();
        openPicker(name);
      } else if (e.code === "KeyE" && !initialParentId && allowEpics) {
        e.preventDefault();
        kind = kind === "task" ? "epic" : "task";
      } else if (e.code === "KeyF") {
        e.preventDefault();
        expanded = !expanded;
      }
    }
  }

  const segBtn = (active: boolean) =>
    "inline-flex items-center gap-1.5 cursor-pointer rounded-md border-0 px-2.5 py-1 text-[0.6875rem] font-medium transition-colors duration-100 " +
    (active
      ? "bg-(--solus-accent-light) text-(--solus-accent)"
      : "bg-transparent text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary)");

  // Shared property-pill trigger styling (neutral chip, accent on hover/focus).
  const PILL =
    "inline-flex items-center gap-1.5 min-h-[1.75rem] cursor-pointer rounded-md border border-(--solus-container-border) bg-(--solus-input-bg-soft) px-2 text-[0.6875rem] text-(--solus-text-secondary) outline-none transition-colors duration-100 hover:border-[color-mix(in_srgb,var(--solus-accent)_35%,transparent)] hover:text-(--solus-text-primary) focus-visible:border-(--solus-accent) disabled:opacity-50";
  // Square ghost icon button in the header (expand / close).
  const ICON_BTN =
    "inline-flex items-center justify-center size-6 flex-shrink-0 border-none rounded-md bg-transparent text-(--solus-text-tertiary) cursor-pointer transition-colors duration-100 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) disabled:opacity-50";
  // Shared option-row styling inside a picker popover.
  const OPT =
    "flex w-full items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-[0.75rem] text-(--solus-text-secondary) cursor-pointer outline-none transition-colors duration-100 hover:bg-(--solus-accent-light) hover:text-(--solus-text-primary) focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary) data-[selected=true]:font-semibold data-[selected=true]:text-(--solus-text-primary)";
  // Layout-only prompt wrapper: the editor reads like AutomationBuilder's unboxed
  // prompt area — the MarkdownEditor ships no border/background of its own, so the
  // wrapper only needs a transparent base plus flex sizing.
  const DESCRIPTION_FIELD = $derived(
    "flex flex-col min-h-0 w-full bg-transparent " +
      "[&_.solus-md-editor-wrap]:flex [&_.solus-md-editor-wrap]:flex-col [&_.solus-md-editor-wrap]:min-h-0 " +
      "[&_.solus-md-editor]:flex [&_.solus-md-editor]:flex-col [&_.solus-md-editor]:min-h-0 " +
      "[&_.solus-md-editor_.ProseMirror]:![font-weight:400] " +
      (expanded
        ? "flex-1 overflow-y-auto [&_.solus-md-editor-wrap]:flex-1 [&_.solus-md-editor]:flex-1 [&_.solus-md-editor_.ProseMirror]:flex-1 [&_.solus-md-editor_.ProseMirror]:min-h-full [&_.solus-md-editor_.ProseMirror]:max-h-none!"
        : ""),
  );
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  data-solus-ui
  class="fixed inset-0 z-[10008] flex items-start justify-center {expanded
    ? 'pt-[7vh]'
    : 'pt-[13vh]'} pointer-events-auto bg-transparent [animation:task-modal-backdrop-in_160ms_ease_both]"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget && !saving) onCancel();
  }}
  onkeydown={onPanelKeydown}
>
  <div
    class="{expanded
      ? 'w-[clamp(20rem,76vw,54rem)] h-[min(44rem,84vh)]'
      : 'w-[clamp(20rem,52vw,34rem)]'} max-w-[calc(100vw-3rem)] outline-none flex flex-col rounded-[1.125rem] border-[0.0625rem] border-(--solus-popover-border) bg-(--solus-popover-bg) shadow-[var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.14)] [.dark_&]:shadow-[var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.06)] overflow-hidden origin-top transition-[width,height] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] [animation:task-modal-enter_200ms_cubic-bezier(0.22,1,0.36,1)_both]"
    role="dialog"
    aria-label={heading}
    aria-modal="true"
  >
    <!-- Header -->
    <div
      class="flex items-center gap-2 px-[1.125rem] h-[2.875rem] flex-shrink-0 relative after:content-[''] after:absolute after:left-[1.125rem] after:right-[1.125rem] after:bottom-0 after:h-[0.0625rem] after:bg-(--solus-popover-border) after:opacity-[0.35]"
    >
      {#if initialParentId}
        <StackIcon
          size={14}
          weight="fill"
          class="flex-shrink-0 text-(--solus-accent)"
        />
      {:else}
        <CheckSquareIcon
          size={14}
          weight="fill"
          class="flex-shrink-0 text-(--solus-accent)"
        />
      {/if}
      <span
        class="text-[0.8125rem] font-semibold tracking-[-0.005em] text-(--solus-text-primary)"
        >{heading}</span
      >
      {#if initialParentId && parentEpic}
        <span class="text-(--solus-text-tertiary)">›</span>
        <span
          class="min-w-0 truncate text-[0.75rem] text-(--solus-text-secondary)"
          >{parentEpic.title}</span
        >
      {/if}
      <button
        type="button"
        class="ml-auto {ICON_BTN}"
        onclick={() => (expanded = !expanded)}
        aria-pressed={expanded}
        title={expanded ? "Collapse (⌥F)" : "Expand (⌥F)"}
        aria-label={expanded ? "Collapse" : "Expand"}
      >
        <!-- Both icons stay mounted and cross-fade (opacity/scale/blur) instead
             of swapping via an {#if} — the toggle animates in both directions. -->
        <span class="grid place-items-center">
          <ArrowsInSimpleIcon
            size={14}
            class="col-start-1 row-start-1 transition-[opacity,scale,filter] duration-300 ease-[cubic-bezier(0.2,0,0,1)] {expanded
              ? 'opacity-100 scale-100 blur-none'
              : 'opacity-0 scale-[0.25] blur-[4px]'}"
          />
          <ArrowsOutSimpleIcon
            size={14}
            class="col-start-1 row-start-1 transition-[opacity,scale,filter] duration-300 ease-[cubic-bezier(0.2,0,0,1)] {expanded
              ? 'opacity-0 scale-[0.25] blur-[4px]'
              : 'opacity-100 scale-100 blur-none'}"
          />
        </span>
      </button>
      <button
        type="button"
        class={ICON_BTN}
        onclick={onCancel}
        disabled={saving}
        aria-label="Close"
      >
        <XIcon size={14} />
      </button>
    </div>

    <!-- Body -->
    <div
      class="flex flex-col gap-1.5 px-[1.125rem] pt-3.5 pb-2 {expanded
        ? 'flex-1 min-h-0'
        : ''}"
    >
      <input
        bind:this={titleEl}
        bind:value={title}
        type="text"
        placeholder="Task title"
        aria-label="Task title"
        disabled={saving}
        class="w-full border-0 border-none outline-none shadow-none appearance-none bg-transparent text-[0.9375rem] font-medium tracking-[-0.01em] text-(--solus-text-primary) placeholder:text-(--solus-text-tertiary) disabled:opacity-60"
        onkeydown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div class={DESCRIPTION_FIELD}>
        <PromptEditor
          value={body}
          onValueChange={(v) => (body = v)}
          pluginCommands={session.pluginCommands}
          {provider}
          {workingDirectory}
          onPlanRefClick={(planId) => session.openPlanModal(planId)}
          onWorkRefClick={(workId, title) =>
            session.openWorkModal(workId, title)}
          menuPlacement="down"
          useRelativeFilePaths
          readOnly={saving}
          maxHeight={expanded ? undefined : 170}
          enterInsertsNewline
          placeholder="Add a description… Use @ for files, # for plans, % for docs, / to format."
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              e.stopPropagation();
              void submit();
            }
          }}
        />
      </div>
    </div>

    <!-- Property row -->
    <div class="flex items-center gap-2 flex-wrap px-[1.125rem] pb-3 shrink-0">
      <!-- Status (local only — GitHub issues always open as open) -->
      {#if allowEpics}
        <button
          type="button"
          bind:this={statusTrigger}
          class={PILL}
          onclick={() => togglePicker("status", statusOpen)}
          aria-haspopup="listbox"
          aria-expanded={statusOpen}
          disabled={saving}
          aria-label="Status"
          title="Status (⌥S)"
        >
          <span class="block size-2 rounded-full {STATUS_META[status].dotClass}"
          ></span>
          {STATUS_META[status].label}
        </button>
        <Dropdown
          bind:open={statusOpen}
          triggerEl={statusTrigger}
          align="bottom"
          anchor="left"
          width={170}
        >
          <div
            bind:this={statusPanel}
            class="py-1"
            role="listbox"
            tabindex="-1"
            aria-label="Set status"
            onkeydown={(e) => pickerKeydown(e, statusPanel)}
          >
            {#each STATUS_OPTIONS as opt (opt)}
              <button
                type="button"
                data-pick-item
                data-selected={status === opt}
                class={OPT}
                onclick={() => commit(() => (status = opt))}
              >
                <span
                  class="block size-2 rounded-full {STATUS_META[opt].dotClass}"
                ></span>
                {STATUS_META[opt].label}
              </button>
            {/each}
          </div>
        </Dropdown>
      {/if}

      <!-- Priority + due date — only when the provider persists them on create -->
      {#if canPlan}
      <button
        type="button"
        bind:this={priorityTrigger}
        class={PILL}
        onclick={() => togglePicker("priority", priorityOpen)}
        aria-haspopup="listbox"
        aria-expanded={priorityOpen}
        disabled={saving}
        aria-label="Priority"
        title="Priority (⌥P)"
      >
        <FlagIcon
          size={12}
          weight={priority ? "fill" : "regular"}
          class={priority
            ? PRIORITY_META[priority].flagClass
            : "text-(--solus-text-tertiary)"}
        />
        {priority ? PRIORITY_META[priority].label : "Priority"}
      </button>
      <Dropdown
        bind:open={priorityOpen}
        triggerEl={priorityTrigger}
        align="bottom"
        anchor="left"
        width={170}
      >
        <div
          bind:this={priorityPanel}
          class="py-1"
          role="listbox"
          tabindex="-1"
          aria-label="Set priority"
          onkeydown={(e) => pickerKeydown(e, priorityPanel)}
        >
          <button
            type="button"
            data-pick-item
            data-selected={priority === ""}
            class={OPT}
            onclick={() => commit(() => (priority = ""))}
          >
            <FlagIcon size={12} class="text-(--solus-text-tertiary)" />
            No priority
          </button>
          {#each PRIORITY_OPTIONS as p (p)}
            <button
              type="button"
              data-pick-item
              data-selected={priority === p}
              class={OPT}
              onclick={() => commit(() => (priority = p))}
            >
              <FlagIcon
                size={12}
                weight="fill"
                class={PRIORITY_META[p].flagClass}
              />
              {PRIORITY_META[p].label}
            </button>
          {/each}
        </div>
      </Dropdown>

      <!-- Due date -->
      <button
        type="button"
        bind:this={dueTrigger}
        class={PILL}
        onclick={() => togglePicker("due", dueOpen)}
        aria-haspopup="dialog"
        aria-expanded={dueOpen}
        disabled={saving}
        aria-label="Due date"
        title="Due date (⌥D)"
      >
        <CalendarBlankIcon size={12} class="text-(--solus-text-tertiary)" />
        {dueLabel ?? "Due date"}
      </button>
      <Dropdown
        bind:open={dueOpen}
        triggerEl={dueTrigger}
        align="bottom"
        anchor="left"
        width={190}
      >
        <div
          bind:this={duePanel}
          class="py-1"
          role="listbox"
          tabindex="-1"
          aria-label="Set due date"
          onkeydown={(e) => pickerKeydown(e, duePanel)}
        >
          {#each presets as preset (preset.iso)}
            <button
              type="button"
              data-pick-item
              data-selected={dueDate === preset.iso}
              class={OPT}
              onclick={() => commit(() => (dueDate = preset.iso))}
            >
              <CalendarBlankIcon
                size={12}
                class="text-(--solus-text-tertiary)"
              />
              {preset.label}
            </button>
          {/each}
          <div
            class="my-1 mx-2 h-px bg-(--solus-popover-border) opacity-40"
          ></div>
          <div class="px-2 pb-1">
            <Input
              type="date"
              bind:value={dueDate}
              aria-label="Custom due date"
              class="w-full cursor-pointer rounded-md border border-(--solus-container-border) bg-(--solus-input-bg-soft) px-2 py-1 text-[0.75rem] text-(--solus-text-secondary) outline-none focus:border-(--solus-accent) [color-scheme:light] [.dark_&]:[color-scheme:dark]"
            />
          </div>
          {#if dueDate}
            <button
              type="button"
              class={OPT}
              onclick={() => commit(() => (dueDate = ""))}
            >
              <XIcon size={12} class="text-(--solus-text-tertiary)" />
              Clear
            </button>
          {/if}
        </div>
      </Dropdown>
      {/if}

      <!-- Labels -->
      <button
        type="button"
        bind:this={labelsTrigger}
        class={PILL}
        onclick={() => togglePicker("labels", labelsOpen)}
        aria-haspopup="dialog"
        aria-expanded={labelsOpen}
        disabled={saving}
        aria-label="Labels"
        title="Labels (⌥L)"
      >
        <TagIcon size={12} class="text-(--solus-text-tertiary)" />
        {labels.length
          ? `${labels.length} label${labels.length > 1 ? "s" : ""}`
          : "Labels"}
      </button>
      <Dropdown
        bind:open={labelsOpen}
        triggerEl={labelsTrigger}
        align="bottom"
        anchor="left"
        width={220}
      >
        <div class="flex flex-col gap-1.5 p-2">
          {#if labels.length}
            <div class="flex flex-wrap gap-1">
              {#each labels as label (label)}
                <span
                  class="inline-flex items-center gap-1 rounded bg-(--solus-surface-hover) px-1.5 py-0.5 text-[0.6875rem] font-medium text-(--solus-text-secondary)"
                >
                  {label}
                  <button
                    type="button"
                    class="relative grid size-3 place-items-center rounded-sm border-0 bg-transparent text-(--solus-text-tertiary) cursor-pointer after:absolute after:-inset-1.5 hover:text-(--solus-text-primary)"
                    onclick={() => removeLabel(label)}
                    aria-label={`Remove ${label}`}
                  >
                    <XIcon size={9} weight="bold" />
                  </button>
                </span>
              {/each}
            </div>
          {/if}
          <Input
            bind:ref={labelInputEl}
            bind:value={labelDraft}
            type="text"
            placeholder="Add a label…"
            aria-label="Add a label"
            class="w-full rounded-md border border-(--solus-container-border) bg-(--solus-input-bg-soft) px-2 py-1 text-[0.75rem] text-(--solus-text-secondary) outline-none focus:border-(--solus-accent)"
            onkeydown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addLabelFromInput();
              }
            }}
          />
          {#if suggestions.length}
            <div
              class="flex flex-col"
              role="listbox"
              aria-label="Label suggestions"
            >
              {#each suggestions as s (s)}
                <button
                  type="button"
                  class={OPT}
                  onclick={() => {
                    labels = addLabel(labels, s);
                    labelDraft = "";
                    labelInputEl?.focus();
                  }}
                >
                  <TagIcon size={11} class="text-(--solus-text-tertiary)" />
                  {s}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      </Dropdown>

      {#if !initialParentId && allowEpics}
        <div
          class="flex gap-0.5 rounded-lg bg-(--solus-surface-hover)/40 p-0.5"
        >
          <button
            type="button"
            class={segBtn(kind === "task")}
            onclick={() => (kind = "task")}
            aria-pressed={kind === "task"}
            disabled={saving}
          >
            <CheckSquareIcon
              size={12}
              weight={kind === "task" ? "fill" : "regular"}
            />
            Task
          </button>
          <button
            type="button"
            class={segBtn(kind === "epic")}
            onclick={() => (kind = "epic")}
            aria-pressed={kind === "epic"}
            disabled={saving}
          >
            <StackIcon
              size={12}
              weight={kind === "epic" ? "fill" : "regular"}
            />
            Epic
          </button>
        </div>

        {#if kind === "task" && epics.length}
          <button
            type="button"
            bind:this={parentTrigger}
            class={PILL}
            onclick={() => togglePicker("parent", parentOpen)}
            aria-haspopup="listbox"
            aria-expanded={parentOpen}
            disabled={saving}
            aria-label="Parent epic"
          >
            <StackIcon size={12} class="text-(--solus-text-tertiary)" />
            <span class="max-w-[10rem] truncate"
              >{parentEpic ? parentEpic.title : "No epic"}</span
            >
          </button>
          <Dropdown
            bind:open={parentOpen}
            triggerEl={parentTrigger}
            align="bottom"
            anchor="left"
            width={220}
          >
            <div
              bind:this={parentPanel}
              class="py-1"
              role="listbox"
              tabindex="-1"
              aria-label="Set parent epic"
              onkeydown={(e) => pickerKeydown(e, parentPanel)}
            >
              <button
                type="button"
                data-pick-item
                data-selected={parentId === ""}
                class={OPT}
                onclick={() => commit(() => (parentId = ""))}
              >
                No epic
              </button>
              {#each epics as epic (epic.id)}
                <button
                  type="button"
                  data-pick-item
                  data-selected={parentId === epic.id}
                  class={OPT}
                  onclick={() => commit(() => (parentId = epic.id))}
                >
                  <StackIcon
                    size={12}
                    class="text-(--solus-text-tertiary) flex-shrink-0"
                  />
                  <span class="truncate">{epic.title}</span>
                </button>
              {/each}
            </div>
          </Dropdown>
        {/if}
      {/if}
    </div>

    <!-- Footer -->
    <div
      class="flex items-center justify-between gap-3 px-[1.125rem] h-[3.25rem] flex-shrink-0 relative before:content-[''] before:absolute before:left-[1.125rem] before:right-[1.125rem] before:top-0 before:h-[0.0625rem] before:bg-(--solus-popover-border) before:opacity-[0.35]"
    >
      <button
        type="button"
        class="inline-flex items-center gap-1.5 cursor-pointer rounded-md border-0 bg-transparent px-1.5 py-1 text-[0.6875rem] text-(--solus-text-tertiary) transition-colors duration-100 hover:text-(--solus-text-secondary) disabled:opacity-50"
        onclick={toggleCreateAnother}
        aria-pressed={createAnother}
        disabled={saving}
        title="Keep this open to add another after creating"
      >
        <span
          class="grid size-3.5 place-items-center rounded-[0.25rem] border transition-colors duration-100 {createAnother
            ? 'border-(--solus-accent) bg-(--solus-accent) text-white'
            : 'border-(--solus-container-border)'}"
        >
          <CheckIcon
            size={9}
            weight="bold"
            class="transition-[opacity,scale,filter] duration-300 ease-[cubic-bezier(0.2,0,0,1)] {createAnother
              ? 'opacity-100 scale-100 blur-none'
              : 'opacity-0 scale-[0.25] blur-[4px]'}"
          />
        </span>
        Create more
      </button>
      <div class="flex items-center gap-1.5">
        <button
          type="button"
          class="cursor-pointer rounded-md border-0 bg-transparent px-2.5 py-[0.3125rem] text-[0.6875rem] font-medium text-(--solus-text-tertiary) transition-colors duration-100 hover:text-(--solus-text-secondary) disabled:opacity-50"
          onclick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 cursor-pointer rounded-md border-0 bg-(--solus-accent) px-3 py-[0.3125rem] text-[0.6875rem] font-semibold text-white transition-[opacity,scale] duration-100 hover:opacity-90 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!canSubmit}
          onclick={submit}
        >
          {#if saving}
            <CircleNotchIcon
              size={12}
              class="animate-spin [animation-duration:0.7s]"
            />
            Creating…
          {:else}
            Create {initialParentId
              ? "sub-task"
              : kind === "epic"
                ? "epic"
                : "task"}
          {/if}
        </button>
        <span
          class="mr-1 inline-flex items-center gap-1.5 text-[0.6875rem] text-(--solus-text-tertiary)"
        >
          <Kbd variant="hint">⌘</Kbd>
          <Kbd variant="hint">↵</Kbd>
        </span>
      </div>
    </div>
  </div>
</div>

<style>
  /* Keyframes can't be expressed as Tailwind utilities; referenced via
     [animation:…] on the backdrop and panel above. */
  @keyframes task-modal-backdrop-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  @keyframes task-modal-enter {
    from {
      opacity: 0;
      transform: translate3d(0, 0.5rem, 0) scale(0.97);
    }
    to {
      opacity: 1;
      transform: translate3d(0, 0, 0) scale(1);
    }
  }
</style>
