<script lang="ts">
  import { tick, untrack } from "svelte";
  import {
    Layers as StackIcon,
    SquareCheck as CheckSquareIcon,
    X as XIcon,
    LoaderCircle as CircleNotchIcon,
    Calendar as CalendarBlankIcon,
    Check as CheckIcon,
    Tag as TagIcon,
    Maximize2 as ArrowsOutSimpleIcon,
    Minimize2 as ArrowsInSimpleIcon,
  } from "@lucide/svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import * as Popover from "../ui/popover";
  import DocumentPromptEditor from "../editor/DocumentPromptEditor.svelte";
  import { Input } from "../ui/input";
  import LabelChip from "../ui/labels/LabelChip.svelte";
  import { getSurfaceContext } from "../../contexts";
  import type { AgentId } from "@solus/contracts/types";
  import { PRIORITY_META, STATUS_META, dueDateMeta } from "./lib/tasks-api";
  import { PICKER_OPTION, PROPERTY_TRIGGER } from "./lib/composer-styles";
  import {
    priorityBars,
    statusTextColor,
  } from "./task-page/lib/task-page";
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
  } from "@solus/contracts/task-types";

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
    /** Project directory for @-file / #-plan / %-work / !-PR autocomplete. */
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
    /** Fires after a successful create, once the composer has dismissed — so a
     *  caller can hand off to another surface. Not called while "Create more"
     *  keeps the composer open. */
    onCreated?: () => void;
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
    onCreated,
    onCancel,
  }: Props = $props();

  const session = getSurfaceContext();

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
    untrack(() => initialStatus) ?? draft?.status ?? "todo",
  );
  let labels = $state<string[]>(draft?.labels ?? []);
  // A preset parent forces a child task; otherwise the user chooses task vs epic.
  let kind = $state<TaskKind>(draft?.kind ?? "task");
  let parentId = $state(draft?.parentId ?? "");
  let createAnother = $state(loadCreateAnother());

  const PRIORITY_OPTIONS: TaskPriority[] = ["urgent", "high", "medium", "low"];
  const STATUS_OPTIONS: TaskStatus[] = ["todo", "in_progress", "done"];
  const presets = dueDatePresets();

  let titleEl = $state<HTMLInputElement | null>(null);
  let descriptionEditor = $state<DocumentPromptEditor | null>(null);
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
  // focus after that teardown settles.
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
  // Names the dialog for assistive technology. Nothing renders it: on screen the
  // title field and the Create button already say what is being made.
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
  // Suggestions only while the user is typing a label: with an empty draft the
  // rail would sprout a list of every known label under the input.
  const suggestions = $derived(
    labelSuggestions(knownLabels, labels, labelDraft),
  );
  const canSubmit = $derived(title.trim().length > 0 && !saving);

  // ── Property pickers (Linear-style popovers) ──────────────────────────────
  // Status, priority, and parent are menus; due date and labels hold an input,
  // so they are popovers — a menu's typeahead would eat the typing.
  type PickerName = "status" | "priority" | "due" | "labels" | "parent";
  let statusOpen = $state(false);
  let priorityOpen = $state(false);
  let dueOpen = $state(false);
  let labelsOpen = $state(false);
  let parentOpen = $state(false);
  let duePanel = $state<HTMLDivElement | null>(null);

  function closePickers() {
    statusOpen = priorityOpen = dueOpen = labelsOpen = parentOpen = false;
  }

  /** ⌥-letter accelerators open one picker and close the rest. */
  function openPicker(name: PickerName) {
    statusOpen = name === "status";
    priorityOpen = name === "priority";
    dueOpen = name === "due";
    labelsOpen = name === "labels";
    parentOpen = name === "parent";
  }

  /** Apply a property choice and close the picker. Closing lands focus on the
   *  title (see `focusTitle`) so the user can keep typing. */
  function commit(apply: () => void) {
    apply();
    closePickers();
  }

  /** A closing picker returns focus to the title rather than its trigger, per
   *  the keyboard-first flow: the next step is typing, not reopening. */
  function focusTitle(e: Event) {
    e.preventDefault();
    titleEl?.focus();
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
    const description = descriptionEditor?.getMarkdown() ?? body;
    // A preset parent (adding from an epic header) always wins and forces a task;
    // otherwise epics never nest and a task takes the chosen parent, if any.
    const parent = initialParentId ?? (kind === "task" ? parentId : "");
    saving = true;
    try {
      await onCreate({
        title: title.trim(),
        body: description.trim(),
        kind: initialParentId ? "task" : kind,
        parentId: parent || undefined,
        // Planning fields only persist where the provider stores them (local).
        dueDate: canPlan ? dueDate || undefined : undefined,
        priority: canPlan ? priority || undefined : undefined,
        // Status is only a real settable field locally; new GitHub issues
        // always start in the open (todo) state.
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
    if (createAnother) {
      resetForAnother();
      return;
    }
    // Dismiss before the hand-off so the modal is gone by the time the caller
    // navigates away.
    onCancel();
    onCreated?.();
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
  // to the Tasks page's `tasks.close` binding and tear down the whole view. An
  // open picker is portalled out of the panel, so its Escape closes only it.
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
      const map = {
        KeyS: "status",
        KeyP: "priority",
        KeyD: "due",
        KeyL: "labels",
      } satisfies Record<string, PickerName>;
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

  // Layout-only wrapper. The shared rich editor owns block formatting and slash
  // commands; this surface only decides how much room the description receives.
  const DESCRIPTION_FIELD = $derived(
    "flex min-h-0 w-full flex-col bg-transparent " +
      (expanded ? "flex-1 overflow-y-auto" : "min-h-[5.5rem]"),
  );
</script>

<!-- The task page's priority mark: four bars, filled to the level. -->
{#snippet priorityGlyph(level: TaskPriority | undefined)}
  <span class="flex h-[9px] shrink-0 items-end gap-[1.5px]" aria-hidden="true">
    {#each priorityBars(level) as bar (bar.height)}
      <span
        class="w-[2.5px] rounded-[0.0625rem]"
        style="height:{bar.height};background:{bar.background}"
      ></span>
    {/each}
  </span>
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  data-solus-ui
  class="fixed inset-0 z-[10008] flex items-start justify-center {expanded
 ? 'pt-[7vh]'
 : 'pt-[13vh]'} pointer-events-auto bg-[color-mix(in_srgb,var(--solus-modal-scrim)_55%,transparent)] [animation:backdrop-fade_160ms_ease_both]"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget && !saving) onCancel();
  }}
  onkeydown={onPanelKeydown}
>
  <div
    class="{expanded
 ? 'w-[clamp(22rem,78vw,60rem)] h-[min(46rem,86vh)]'
 : 'w-[clamp(22rem,64vw,46rem)]'} max-w-[calc(100vw-3rem)] outline-none flex flex-col text-sm rounded-xl border-[0.0625rem] border-(--solus-popover-border) bg-(--solus-popover-bg) shadow-[var(--solus-popover-shadow)] overflow-hidden origin-top transition-[width,height] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] [animation:task-modal-enter_200ms_cubic-bezier(0.22,1,0.36,1)_backwards]"
    role="dialog"
    aria-label={heading}
    aria-modal="true"
  >
    <!-- A sub-task's parent, on its own line above the title. Nothing else in
         the panel names it, and it belongs with the title rather than beside
         the window controls. -->
    {#if initialParentId && parentEpic}
      <div class="px-5 pt-4 flex-shrink-0">
        <span class="block truncate text-xs text-(--solus-text-tertiary)"
          >{parentEpic.title}</span
        >
      </div>
    {/if}

    <!-- Header: the title IS the header. The panel's own name was noise, so the
         field the user types into takes that line, with the window controls on
         its right. The placeholder stays visibly softer than entered text so
         it reads as a prompt rather than a pre-filled title.

         The `!` on the placeholder colour is load-bearing: index.css sets
         `input::placeholder` unlayered, and an unlayered declaration outranks
         every layered utility, so the plain class was silently dead and the
         title's prompt rendered in the same grey as the description's. -->
    <div
      class="flex items-center gap-1 px-5 {initialParentId &&
      parentEpic
        ? 'pt-1'
        : 'pt-4'} flex-shrink-0"
    >
      <Input
        bind:ref={titleEl}
        bind:value={title}
        type="text"
        placeholder="Title"
        aria-label="Task title"
        disabled={saving}
        class="h-auto min-w-0 flex-1 appearance-none rounded-none border-0 bg-transparent! p-0 text-lg leading-7 font-semibold tracking-[-0.014em] text-(--solus-text-primary) shadow-none outline-none placeholder:font-semibold placeholder:text-(--solus-text-tertiary)! placeholder:opacity-70! focus-visible:ring-0 disabled:opacity-60 dark:bg-transparent!"
        onkeydown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <button
        type="button"
        class="ml-auto inline-flex size-7 flex-shrink-0 cursor-pointer items-center justify-center rounded-md border-none bg-transparent text-(--solus-text-tertiary) transition-colors duration-100 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) disabled:opacity-50"
        onclick={() => (expanded = !expanded)}
        aria-pressed={expanded}
        title={expanded ? "Collapse (⌥F)" : "Expand (⌥F)"}
        aria-label={expanded ? "Collapse" : "Expand"}
      >
        <!-- Both icons stay mounted and cross-fade (opacity/scale/blur) instead
             of swapping via an {#if} — the toggle animates in both directions. -->
        <span class="grid place-items-center">
          <ArrowsInSimpleIcon
            size={15}
            class="col-start-1 row-start-1 transition-[opacity,scale,filter] duration-300 ease-[cubic-bezier(0.2,0,0,1)] {expanded
 ? 'opacity-100 scale-100 blur-none'
 : 'opacity-0 scale-[0.25] blur-[4px]'}"
          />
          <ArrowsOutSimpleIcon
            size={15}
            class="col-start-1 row-start-1 transition-[opacity,scale,filter] duration-300 ease-[cubic-bezier(0.2,0,0,1)] {expanded
 ? 'opacity-0 scale-[0.25] blur-[4px]'
 : 'opacity-100 scale-100 blur-none'}"
          />
        </span>
      </button>
      <button
        type="button"
        class="inline-flex size-7 flex-shrink-0 cursor-pointer items-center justify-center rounded-md border-none bg-transparent text-(--solus-text-tertiary) transition-colors duration-100 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) disabled:opacity-50"
        onclick={onCancel}
        disabled={saving}
        aria-label="Close"
      >
        <XIcon size={16} />
      </button>
    </div>

    <!-- Body: the description, then the properties — what the task says, then
         what it is. -->
    <div
      class="flex min-w-0 flex-col px-5 pt-1 pb-3 {expanded
 ? 'flex-1 min-h-0'
 : ''}"
    >
      <div class={DESCRIPTION_FIELD}>
        <DocumentPromptEditor
          bind:this={descriptionEditor}
          value={body}
          onValueChange={(v) => (body = v)}
          pluginCommands={session.pluginCommands}
          {provider}
          {workingDirectory}
          menuPlacement="down"
          useRelativeFilePaths
          readOnly={saving}
          maxHeight={expanded ? undefined : 280}
          placeholder="Add a description, or type / for commands"
          dictation
          class="task-composer-description flex min-h-0 flex-1 flex-col"
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

      <!-- Properties: one row of outlined chips under the description. -->
      <div
        class="flex flex-wrap items-center gap-1.5 px-5 pb-4 shrink-0"
      >
      <!-- Type — absent when the parent is preset (always a sub-task) or the
           provider has no epics. One control that names what it is now and
           swaps on click, rather than a segmented control shouting both. -->
      {#if !initialParentId && allowEpics}
        <button
          type="button"
          class={PROPERTY_TRIGGER}
          onclick={() => (kind = kind === "task" ? "epic" : "task")}
          disabled={saving}
          aria-label="Type"
          title={kind === "epic"
            ? "Epic — switch to task (⌥E)"
            : "Task — switch to epic (⌥E)"}
        >
          {#if kind === "epic"}
            <StackIcon size={13} class="shrink-0 text-violet-600 [.dark_&]:text-violet-400" />
          {:else}
            <CheckSquareIcon size={13} class="shrink-0 text-sky-600 [.dark_&]:text-sky-400" />
          {/if}
          {kind === "epic" ? "Epic" : "Task"}
        </button>
      {/if}

      <!-- Status (local only — new GitHub issues always start open/todo) -->
      {#if allowEpics}
        <DropdownMenu.Root bind:open={statusOpen}>
          <DropdownMenu.Trigger disabled={saving}>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class={PROPERTY_TRIGGER}
                aria-label="Status"
                title="Status (⌥S)"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 14 14"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.45"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="shrink-0"
                  style="color:{statusTextColor(status)}"
                  aria-hidden="true"><path d={STATUS_META[status].glyph} /></svg
                >
                {STATUS_META[status].label}
              </button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content
            align="start"
            sideOffset={6}
            class="z-[10010] w-[170px]"
            aria-label="Set status"
            onCloseAutoFocus={focusTitle}
          >
            {#each STATUS_OPTIONS as opt (opt)}
              <DropdownMenu.Item onSelect={() => commit(() => (status = opt))}>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 14 14"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.45"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="shrink-0"
                  style="color:{statusTextColor(opt)}"
                  aria-hidden="true"><path d={STATUS_META[opt].glyph} /></svg
                >
                {STATUS_META[opt].label}
                {#if opt === status}
                  <span class="ml-auto text-primary" aria-hidden="true">✓</span>
                {/if}
              </DropdownMenu.Item>
            {/each}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      {/if}

      <!-- Priority + target date — only when the provider persists them on create -->
      {#if canPlan}
        <DropdownMenu.Root bind:open={priorityOpen}>
          <DropdownMenu.Trigger disabled={saving}>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class={PROPERTY_TRIGGER}
                aria-label="Priority"
                title="Priority (⌥P)"
              >
                {@render priorityGlyph(priority || undefined)}
                <span class={priority ? PRIORITY_META[priority].flagClass : ""}
                  >{priority ? PRIORITY_META[priority].label : "Priority"}</span
                >
              </button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content
            align="start"
            sideOffset={6}
            class="z-[10010] w-[170px]"
            aria-label="Set priority"
            onCloseAutoFocus={focusTitle}
          >
            <DropdownMenu.Item onSelect={() => commit(() => (priority = ""))}>
              {@render priorityGlyph(undefined)}
              No priority
              {#if priority === ""}
                <span class="ml-auto text-primary" aria-hidden="true">✓</span>
              {/if}
            </DropdownMenu.Item>
            {#each PRIORITY_OPTIONS as p (p)}
              <DropdownMenu.Item onSelect={() => commit(() => (priority = p))}>
                {@render priorityGlyph(p)}
                {PRIORITY_META[p].label}
                {#if priority === p}
                  <span class="ml-auto text-primary" aria-hidden="true">✓</span>
                {/if}
              </DropdownMenu.Item>
            {/each}
          </DropdownMenu.Content>
        </DropdownMenu.Root>

        <Popover.Root bind:open={dueOpen}>
          <Popover.Trigger disabled={saving}>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class={PROPERTY_TRIGGER}
                aria-label="Target date"
                title="Target date (⌥D)"
              >
                <CalendarBlankIcon size={13} class="shrink-0 text-rose-600 [.dark_&]:text-rose-400" />
                {dueLabel ?? "Target"}
              </button>
            {/snippet}
          </Popover.Trigger>
          <Popover.Content
            data-solus-ui
            side="bottom"
            align="start"
            sideOffset={6}
            collisionPadding={8}
            class="menu-surface z-[10010] w-[190px] gap-0 rounded-2xl bg-(--solus-menu-bg) p-1.5 max-h-(--bits-popover-content-available-height) overflow-y-auto shadow-[shadow:var(--solus-menu-shadow)] ring-0"
            aria-label="Set due date"
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              focusFirstItem(duePanel);
            }}
            onCloseAutoFocus={focusTitle}
          >
        <div
          bind:this={duePanel}
          class="py-1"
          role="listbox"
          tabindex="-1"
          onkeydown={(e) => pickerKeydown(e, duePanel)}
        >
          {#each presets as preset (preset.iso)}
            <button
              type="button"
              data-pick-item
              data-selected={dueDate === preset.iso}
              class={PICKER_OPTION}
              onclick={() => commit(() => (dueDate = preset.iso))}
            >
              <CalendarBlankIcon
                size={14}
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
              class="w-full cursor-pointer rounded-md border border-(--solus-container-border) bg-(--solus-input-bg-soft) px-2 py-1 font-secondary text-(--solus-text-secondary) outline-none focus:border-(--solus-accent) [color-scheme:light] [.dark_&]:[color-scheme:dark]"
            />
          </div>
          {#if dueDate}
            <button
              type="button"
              class={PICKER_OPTION}
              onclick={() => commit(() => (dueDate = ""))}
            >
              <XIcon size={14} class="text-(--solus-text-tertiary)" />
              Clear
            </button>
          {/if}
        </div>
          </Popover.Content>
        </Popover.Root>
      {/if}

      <!-- Labels: the chosen ones ARE the label of the control, so a filled row
           reads without opening anything. -->
      <Popover.Root bind:open={labelsOpen}>
        <Popover.Trigger disabled={saving}>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              class="max-w-[14rem] {PROPERTY_TRIGGER}"
              aria-label="Labels"
              title="Labels (⌥L)"
            >
              <TagIcon size={13} class="shrink-0 text-emerald-600 [.dark_&]:text-emerald-400" />
              <span class="truncate">{labels.join(", ") || "Labels"}</span>
            </button>
          {/snippet}
        </Popover.Trigger>
        <Popover.Content
          data-solus-ui
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          class="menu-surface z-[10010] w-[224px] gap-0 rounded-2xl bg-(--solus-menu-bg) p-1.5 max-h-(--bits-popover-content-available-height) overflow-y-auto shadow-[shadow:var(--solus-menu-shadow)] ring-0"
          aria-label="Labels"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            labelInputEl?.focus();
          }}
          onCloseAutoFocus={focusTitle}
        >
        <div class="flex flex-col gap-1.5 p-0.5">
          {#if labels.length}
            <div class="flex flex-wrap gap-1">
              {#each labels as label (label)}
                <span class="inline-flex items-center gap-0.5">
                  <LabelChip {label} />
                  <button
                    type="button"
                    class="relative grid size-4 place-items-center rounded-full border-0 bg-transparent text-(--solus-text-tertiary) cursor-pointer after:absolute after:-inset-1 hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary)"
                    onclick={() => removeLabel(label)}
                    aria-label={`Remove ${label}`}
                  >
                    <XIcon size={12} weight="bold" />
                  </button>
                </span>
              {/each}
            </div>
          {/if}
          <Input
            dictation={false}
            bind:ref={labelInputEl}
            bind:value={labelDraft}
            type="text"
            placeholder="Add a label…"
            aria-label="Add a label"
            class="h-9 text-workspace-chrome pointer-fine:[.is-laptop-display_&]:h-8"
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
                  class={PICKER_OPTION}
                  onclick={() => {
                    labels = addLabel(labels, s);
                    labelDraft = "";
                    labelInputEl?.focus();
                  }}
                >
                  <TagIcon size={13} class="text-(--solus-text-tertiary)" />
                  {s}
                </button>
              {/each}
            </div>
          {/if}
        </div>
        </Popover.Content>
      </Popover.Root>

      {#if !initialParentId && allowEpics}
        {#if kind === "task" && epics.length}
          <DropdownMenu.Root bind:open={parentOpen}>
            <DropdownMenu.Trigger disabled={saving}>
              {#snippet child({ props })}
                <button
                  {...props}
                  type="button"
                  class="max-w-[12rem] {PROPERTY_TRIGGER}"
                  aria-label="Parent epic"
                >
                  <StackIcon size={13} class="shrink-0 text-violet-600 [.dark_&]:text-violet-400" />
                  <span class="truncate"
                    >{parentEpic ? parentEpic.title : "No epic"}</span
                  >
                </button>
              {/snippet}
            </DropdownMenu.Trigger>
            <DropdownMenu.Content
              align="start"
              sideOffset={6}
              class="z-[10010] w-[220px]"
              aria-label="Set parent epic"
              onCloseAutoFocus={focusTitle}
            >
              <DropdownMenu.Item onSelect={() => commit(() => (parentId = ""))}>
                No epic
                {#if parentId === ""}
                  <span class="ml-auto text-primary" aria-hidden="true">✓</span>
                {/if}
              </DropdownMenu.Item>
              {#each epics as epic (epic.id)}
                <DropdownMenu.Item
                  onSelect={() => commit(() => (parentId = epic.id))}
                >
                  <StackIcon
                    size={14}
                    class="text-(--solus-text-tertiary) flex-shrink-0"
                  />
                  <span class="truncate">{epic.title}</span>
                  {#if parentId === epic.id}
                    <span class="ml-auto text-primary" aria-hidden="true">✓</span>
                  {/if}
                </DropdownMenu.Item>
              {/each}
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        {/if}
      {/if}
    </div>

    <div
      class="flex items-center justify-between gap-3 px-5 py-3 flex-shrink-0 border-t border-(--solus-popover-border) bg-(--solus-surface-hover)/40"
    >
      <!-- Ticked is neutral-strong rather than accent: the accent belongs to
           Create, and a terracotta box here outweighed the button it sits
           beside. -->
      <button
        type="button"
        class="-ml-1 inline-flex h-8 items-center gap-2 cursor-pointer rounded-md border-0 bg-transparent px-1 text-(--solus-text-secondary) outline-none transition-colors duration-150 hover:text-(--solus-text-secondary) focus-visible:text-(--solus-text-secondary) disabled:opacity-50"
        onclick={toggleCreateAnother}
        role="checkbox"
        aria-checked={createAnother}
        disabled={saving}
        title="Keep this open to add another after creating"
      >
        <span
          class="grid size-4 shrink-0 place-items-center rounded-[0.3125rem] border transition-[background-color,border-color] duration-150 {createAnother
            ? 'border-(--solus-text-primary) bg-(--solus-text-primary) text-(--solus-popover-bg)'
            : 'border-(--solus-container-border) bg-transparent'}"
        >
          <CheckIcon
            size={10}
            weight="bold"
            class="transition-opacity duration-150 {createAnother
              ? 'opacity-100'
              : 'opacity-0'}"
          />
        </span>
        Create more
      </button>
      <div class="flex items-center gap-1.5">
        <button
          type="button"
          class="h-8 cursor-pointer rounded-md border-0 bg-transparent px-3 font-medium text-(--solus-text-secondary) transition-[background-color,color,scale] duration-100 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50"
          onclick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
        <!-- The shortcut is set inside the button as plain dimmed text: two
             loose keycaps at the panel's edge read as leftovers, and a chip
             inside a filled button is one surface too many. Disabled keeps the
             accent at reduced strength, so the primary action stays
             identifiable before the title is typed. -->
        <button
          type="button"
          class="inline-flex items-center gap-2 cursor-pointer h-8 rounded-md border-0 bg-(--solus-accent) px-3 font-semibold text-white shadow-[0_1px_2px_rgb(0_0_0/0.12)] transition-[filter,opacity,scale] duration-150 hover:brightness-[1.06] active:scale-[0.97] disabled:cursor-default disabled:opacity-70 disabled:shadow-none disabled:hover:brightness-100 disabled:active:scale-100"
          disabled={!canSubmit}
          onclick={submit}
        >
          {#if saving}
            <CircleNotchIcon
              size={14}
              class="animate-spin [animation-duration:0.7s]"
            />
            Creating…
          {:else}
            Create {initialParentId
              ? "sub-task"
              : kind === "epic"
                ? "epic"
                : "task"}
            <span class="opacity-55 tabular-nums">⌘↵</span>
          {/if}
        </button>
      </div>
    </div>
  </div>
</div>

<style>
  :global(.task-composer-description .solus-doc-editor .ProseMirror) {
    min-height: 5rem;
    padding: 0.25rem 0 0.5rem;
    font-weight: 400;
  }

  /* Scoped, unlayered, and therefore ahead of the utility classes that carry
     these animations: a reduced-motion reader gets the finished dialog. */
  @media (prefers-reduced-motion: reduce) {
    div {
      animation: none !important;
    }
  }

  /* The backdrop uses the app-wide `backdrop-fade`; only the panel's own entry
     is local. Keyframes can't be expressed as Tailwind utilities, so it is
     referenced via [animation:…] on the panel above. */
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
