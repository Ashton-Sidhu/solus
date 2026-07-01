<script lang="ts">
  import { tick } from "svelte";
  import {
    PlusIcon,
    XIcon,
    PlayIcon,
    PauseIcon,
    StopIcon,
    TrashIcon,
    PencilSimpleIcon,
    StarIcon,
    LightningIcon,
    CircleNotchIcon,
    MagnifyingGlassIcon,
    CaretDownIcon,
  } from "phosphor-svelte";
  import type { Automation } from "../../../shared/types";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { getWindowContext } from "../../contexts/window.context.svelte";
  import { runtime } from "../../contexts/runtime.svelte";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { matchesOpenProjects } from "../../lib/sessionUtils";
  import { triggerSummary } from "./lib/automation-format";
  import { toasts } from "../../contexts/toast.store.svelte";
  import AutomationBuilder from "./AutomationBuilder.svelte";
  import Input from "../ui/Input.svelte";
  import Dropdown from "../ui/Dropdown.svelte";
  import DropdownItem from "../ui/DropdownItem.svelte";

  const session = getWorkspaceContext();
  const windowCtx = getWindowContext();
  const store = session.automationsStore;

  const open = $derived(session.automationsOpen);
  // Editor mode opens the builder in the side panel; pill mode has no pane, so it
  // keeps editing inline within this overlay.
  const isEditorMode = $derived(windowCtx.viewMode === "editor");

  // view: the list, or the create/edit builder.
  type View =
    | { kind: "list" }
    | { kind: "edit"; automation: Automation | null };
  let view = $state<View>({ kind: "list" });

  // Scoped to the projects with open sessions in the sidebar; falls back to the
  // status bar's project path when no sessions are open (handled by the getter).
  const scopeRoots = $derived(session.openProjectScopeRoots);

  // ── Command bar: search + status filter + favourites + sort ──
  type StatusFilter = "all" | "active" | "paused";
  type SortMode = "recent" | "name";
  type StatusSectionId = "running" | "failed" | "active" | "paused";
  type StatusSection = {
    id: StatusSectionId;
    label: string;
    items: Automation[];
  };
  const SORT_OPTIONS: { value: SortMode; label: string }[] = [
    { value: "recent", label: "Recent" },
    { value: "name", label: "Name" },
  ];
  const STATUS_SECTION_ORDER: { id: StatusSectionId; label: string }[] = [
    { id: "running", label: "Running" },
    { id: "failed", label: "Needs attention" },
    { id: "active", label: "Active" },
    { id: "paused", label: "Paused" },
  ];

  let query = $state("");
  let statusFilter = $state<StatusFilter>("all");
  let showStarred = $state(false);
  let sortMode = $state<SortMode>("recent");
  let sortMenuOpen = $state(false);
  let sortTriggerEl = $state<HTMLButtonElement | null>(null);
  let searchEl = $state<HTMLInputElement | HTMLTextAreaElement | null>(null);

  const sortLabel = $derived(
    SORT_OPTIONS.find((o) => o.value === sortMode)?.label ?? "",
  );
  const newBtnClass =
    "inline-flex cursor-pointer items-center gap-[0.3125rem] rounded-[0.4375rem] border-0 bg-(--solus-accent-light) px-2.5 py-[0.3125rem] text-[0.6875rem] font-semibold text-(--solus-accent) transition-[background-color] duration-[var(--duration-quick,0.12s)] ease-in-out hover:bg-[color-mix(in_srgb,var(--solus-accent-light)_100%,var(--solus-accent)_14%)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] [@media(pointer:coarse)]:min-h-10 [@media(pointer:coarse)]:px-3.5 [@media(pointer:coarse)]:text-[0.8125rem]";
  const iconBtnClass =
    "relative inline-flex size-[1.625rem] cursor-pointer items-center justify-center rounded-[0.4375rem] border-0 bg-transparent text-(--solus-text-tertiary) transition-[background-color,color] duration-100 ease-in-out disabled:cursor-not-allowed disabled:opacity-35 [&:hover:not(:disabled)]:bg-(--solus-surface-hover) [&:hover:not(:disabled)]:text-(--solus-text-primary) focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary) focus-visible:outline-none [@media(pointer:coarse)]:size-11";
  const dangerIconBtnClass = `${iconBtnClass} [&:hover:not(:disabled)]:bg-[color-mix(in_srgb,var(--solus-status-error,#e53e3e)_14%,transparent)] [&:hover:not(:disabled)]:text-[var(--solus-status-error,#e53e3e)]`;
  const stateBtnClass =
    "grid size-7 shrink-0 cursor-pointer place-items-center rounded-[0.4375rem] border-0 bg-transparent text-(--solus-text-tertiary) transition-[background-color,color] duration-100 ease-in-out hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary) focus-visible:outline-none [@media(pointer:coarse)]:size-11";

  // The visible universe: automations under a currently-open project.
  const scoped = $derived(
    store.items.filter((a) => matchesOpenProjects(a.action.cwd, scopeRoots)),
  );

  const counts = $derived.by(() => {
    let active = 0;
    let paused = 0;
    for (const a of scoped) a.enabled ? active++ : paused++;
    return { all: scoped.length, active, paused };
  });

  // Flat, filtered, sorted list. Sections are built from this result so search,
  // starred-only, and status tabs still apply before grouping.
  const automations = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return scoped
      .filter((a) => {
        if (statusFilter === "active" && !a.enabled) return false;
        if (statusFilter === "paused" && a.enabled) return false;
        if (showStarred && !a.favorite) return false;
        if (!q) return true;
        return (
          a.name.toLowerCase().includes(q) ||
          folderLabel(a.action.cwd).toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        if (!!a.favorite !== !!b.favorite) return a.favorite ? -1 : 1;
        if (sortMode === "name") return a.name.localeCompare(b.name);
        return b.updatedAt.localeCompare(a.updatedAt);
      });
  });

  const automationSections: StatusSection[] = $derived.by(() => {
    const groups = new Map<StatusSectionId, Automation[]>();
    for (const a of automations) {
      const sectionId: StatusSectionId =
        a.lastRunStatus === "running"
          ? "running"
          : a.enabled && a.lastRunStatus === "failed"
            ? "failed"
            : a.enabled
              ? "active"
              : "paused";
      let group = groups.get(sectionId);
      if (!group) {
        group = [];
        groups.set(sectionId, group);
      }
      group.push(a);
    }
    return STATUS_SECTION_ORDER.filter((section) => groups.has(section.id)).map(
      (section) => ({
        ...section,
        items: groups.get(section.id)!,
      }),
    );
  });

  $effect(() => {
    if (open) {
      // Reset the command bar each time the page opens.
      query = "";
      statusFilter = "all";
      showStarred = false;
      sortMode = "recent";
      // Deep-link: jump straight into one automation's editor when a focus id was
      // set (e.g. from the project panel or a "Sent via automation" badge), then
      // consume it so re-opening the page lands back on the list.
      const focusId = session.automationsFocusId;
      if (focusId) {
        session.automationsFocusId = null;
        void store.loadAll().then(() => {
          const target = store.get(focusId);
          view = target
            ? { kind: "edit", automation: target }
            : { kind: "list" };
        });
      } else {
        view = { kind: "list" };
        void store.loadAll();
        if (!runtime.shouldSuppressFocus) {
          void tick().then(() => searchEl?.focus());
        }
      }
    }
  });

  useScope("automations", { active: () => open });
  useKeybinding(
    "automations.close",
    () => {
      // Esc backs out of the builder modal first, then closes the page.
      if (view.kind === "edit") backToList();
      else close();
    },
    { enabled: () => open },
  );
  useKeybinding("automations.new", () => startCreate(), {
    enabled: () => open && view.kind === "list",
  });

  function close() {
    session.automationsOpen = false;
    requestInputFocus();
  }

  // The folder the automation runs in — shown as a muted secondary label.
  function folderLabel(cwd: string): string {
    const parts = cwd.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? cwd;
  }

  function startCreate() {
    if (isEditorMode) {
      session.openAutomationBuilder(null);
      return;
    }
    view = { kind: "edit", automation: null };
  }
  function startEdit(a: Automation) {
    if (isEditorMode) {
      session.openAutomationBuilder(a.id);
      return;
    }
    view = { kind: "edit", automation: a };
  }
  function backToList() {
    view = { kind: "list" };
  }

  async function toggleEnabled(a: Automation, e: Event) {
    e.stopPropagation();
    await store.setEnabled(a.id, !a.enabled);
  }

  async function runNow(a: Automation, e: Event) {
    e.stopPropagation();
    await store.runNow(a.id);
  }

  async function cancelRun(a: Automation, e: Event) {
    e.stopPropagation();
    await store.cancel(a.id);
  }

  async function toggleFavorite(a: Automation, e: Event) {
    e.stopPropagation();
    await store.setFavorite(a.id, !a.favorite);
  }

  function deleteAutomation(a: Automation, e: Event) {
    e.stopPropagation();
    // Hide the row immediately, then offer a brief undo window. The on-disk
    // delete is deferred until the toast commits (matches document delete).
    if (!store.softRemove(a.id)) return;
    toasts.undo("Automation deleted", () => store.restorePending(), {
      onDismiss: () => void store.commitPending(),
    });
  }
</script>

{#if open}
  <div
    class="@container relative flex min-h-0 flex-1 flex-col overflow-hidden bg-(--solus-container-bg) focus:outline-none"
    role="dialog"
    aria-label="Automations"
    tabindex="-1"
  >
    {#if view.kind === "edit"}
      <!-- ── Full-page automation detail / editor ── -->
      <AutomationBuilder automation={view.automation} onDone={backToList} />
    {:else}
      <!-- ── Header: title row + command bar ── -->
      <div class="shrink-0 border-b border-(--solus-popover-border)">
        <div class="flex items-center justify-between gap-3 px-5 py-2">
          <div class="flex min-w-0 items-center gap-2">
            <LightningIcon
              size={15}
              weight="fill"
              class="text-(--solus-accent)"
            />
            <span
              class="whitespace-nowrap text-[0.8125rem] font-semibold text-(--solus-text-primary)"
              >Automations</span
            >
          </div>
          <div class="flex items-center gap-1.5">
            <button
              type="button"
              class={newBtnClass}
              onclick={startCreate}
              data-testid="automation-new"
            >
              <PlusIcon size={13} weight="bold" />
              <span>New</span>
            </button>
            <button
              type="button"
              class={iconBtnClass}
              onclick={close}
              aria-label="Close"
            >
              <XIcon size={16} />
            </button>
          </div>
        </div>

        <div
          class="flex items-center gap-2.5 px-5 pb-2.5 pt-1 @max-[44rem]:flex-col @max-[44rem]:items-stretch @max-[44rem]:gap-0 @max-[44rem]:p-0"
        >
          <div
            class="flex min-w-0 flex-1 items-center gap-2 @max-[44rem]:flex-none @max-[44rem]:px-5 @max-[44rem]:pb-2 @max-[44rem]:pt-1"
          >
            <MagnifyingGlassIcon
              size={15}
              class="text-(--solus-text-tertiary) flex-shrink-0"
            />
            <Input
              bind:el={searchEl}
              bind:value={query}
              type="text"
              variant="bare"
              size="lg"
              placeholder="Search automations…"
              class="[@media(pointer:coarse)]:text-[16px]"
            />
          </div>
          <div
            class="h-4 w-px shrink-0 bg-(--solus-container-border) @max-[44rem]:hidden"
            aria-hidden="true"
          ></div>
          <div
            class="flex shrink-0 items-center gap-2.5 @max-[44rem]:justify-between @max-[44rem]:px-5 @max-[44rem]:pb-2.5 @max-[44rem]:pt-0 @max-[32rem]:gap-1.5"
          >
            <div
              class="flex min-w-0 gap-0.5 @max-[32rem]:grid @max-[32rem]:flex-1 @max-[32rem]:grid-cols-3"
            >
              <button
                type="button"
                class="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-lg border-0 px-[0.5625rem] py-1 text-[0.6875rem] transition-[background-color,color] duration-100 ease-in-out @max-[32rem]:min-w-0 @max-[32rem]:justify-center @max-[32rem]:gap-[0.1875rem] @max-[32rem]:px-[0.1875rem] {statusFilter ===
                'all'
                  ? 'bg-(--solus-accent-light) text-(--solus-accent)'
                  : 'bg-transparent text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary)'}"
                onclick={() => (statusFilter = "all")}
                aria-pressed={statusFilter === "all"}
                aria-label={`All automations (${counts.all})`}
              >
                All <span class="tabular-nums opacity-70">{counts.all}</span>
              </button>
              <button
                type="button"
                class="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-lg border-0 px-[0.5625rem] py-1 text-[0.6875rem] transition-[background-color,color] duration-100 ease-in-out @max-[32rem]:min-w-0 @max-[32rem]:justify-center @max-[32rem]:gap-[0.1875rem] @max-[32rem]:px-[0.1875rem] {statusFilter ===
                'active'
                  ? 'bg-(--solus-accent-light) text-(--solus-accent)'
                  : 'bg-transparent text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary)'}"
                onclick={() => (statusFilter = "active")}
                aria-pressed={statusFilter === "active"}
                aria-label={`Active automations (${counts.active})`}
              >
                <span
                  class="size-[0.4375rem] shrink-0 rounded-full {statusFilter ===
                  'active'
                    ? 'bg-(--solus-accent)'
                    : 'bg-(--solus-text-secondary)'}"
                ></span>
                <span class="@max-[32rem]:hidden">Active</span>
                <span class="hidden @max-[32rem]:inline" aria-hidden="true"
                  >On</span
                >
                <span class="tabular-nums opacity-70">{counts.active}</span>
              </button>
              <button
                type="button"
                class="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-lg border-0 px-[0.5625rem] py-1 text-[0.6875rem] transition-[background-color,color] duration-100 ease-in-out @max-[32rem]:min-w-0 @max-[32rem]:justify-center @max-[32rem]:gap-[0.1875rem] @max-[32rem]:px-[0.1875rem] {statusFilter ===
                'paused'
                  ? 'bg-(--solus-accent-light) text-(--solus-accent)'
                  : 'bg-transparent text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary)'}"
                onclick={() => (statusFilter = "paused")}
                aria-pressed={statusFilter === "paused"}
                aria-label={`Paused automations (${counts.paused})`}
              >
                <span
                  class="size-[0.4375rem] shrink-0 rounded-full border border-(--solus-text-tertiary)"
                ></span>
                <span class="@max-[32rem]:hidden">Paused</span>
                <span class="hidden @max-[32rem]:inline" aria-hidden="true"
                  >Off</span
                >
                <span class="tabular-nums opacity-70">{counts.paused}</span>
              </button>
            </div>
            <div class="flex shrink-0 gap-1">
              <button
                type="button"
                class="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-lg border px-2 py-1 text-[0.6875rem] transition-[background-color,border-color,color] duration-100 ease-in-out hover:bg-(--solus-accent-light) hover:text-(--solus-text-primary) @max-[32rem]:w-[1.875rem] @max-[32rem]:justify-center @max-[32rem]:px-0 {showStarred
                  ? 'border-(--solus-accent-border) bg-(--solus-accent-light) text-(--solus-accent)'
                  : 'border-(--solus-container-border) bg-transparent text-(--solus-text-secondary)'}"
                onclick={() => (showStarred = !showStarred)}
                aria-pressed={showStarred}
                aria-label="Starred automations"
                title="Starred automations"
              >
                <StarIcon size={11} weight={showStarred ? "fill" : "regular"} />
                <span class="@max-[32rem]:hidden">Starred</span>
              </button>
            </div>
          </div>
          <div
            class="h-4 w-px shrink-0 bg-(--solus-container-border) @max-[44rem]:hidden"
            aria-hidden="true"
          ></div>
          <div
            class="relative flex shrink-0 items-center gap-1.5 @max-[44rem]:justify-end @max-[44rem]:px-5 @max-[44rem]:pb-2.5 @max-[44rem]:pt-0"
          >
            <button
              type="button"
              bind:this={sortTriggerEl}
              class="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border border-(--solus-container-border) bg-(--solus-input-bg-soft) px-2 py-[0.1875rem] text-[0.6875rem] text-(--solus-text-secondary) outline-none transition-[border-color] duration-100 ease-in-out focus-visible:border-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
              aria-label="Sort automations"
              aria-haspopup="listbox"
              aria-expanded={sortMenuOpen}
              onclick={() => (sortMenuOpen = !sortMenuOpen)}
            >
              <span>{sortLabel}</span>
              <CaretDownIcon
                size={9}
                class="shrink-0 text-(--solus-text-tertiary)"
              />
            </button>
            <Dropdown
              bind:open={sortMenuOpen}
              triggerEl={sortTriggerEl}
              align="top"
              anchor="right"
              width={140}
            >
              <div class="py-1" role="listbox" aria-label="Sort automations">
                {#each SORT_OPTIONS as opt (opt.value)}
                  <DropdownItem
                    selected={sortMode === opt.value}
                    onclick={() => {
                      sortMode = opt.value;
                      sortMenuOpen = false;
                    }}
                  >
                    {opt.label}
                  </DropdownItem>
                {/each}
              </div>
            </Dropdown>
          </div>
        </div>
      </div>

      <!-- ── Body: the list ── -->
      <div
        class="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-4 pb-6 pt-3 [scrollbar-width:thin]"
      >
        {#if !store.loaded && store.loading}
          <div
            class="flex flex-col items-center justify-center gap-[0.4375rem] px-4 py-16 text-center"
          >
            <CircleNotchIcon
              size={20}
              class="animate-spin text-(--solus-text-tertiary) [animation-duration:0.9s]"
            />
          </div>
        {:else if counts.all === 0}
          <div
            class="flex flex-col items-center justify-center gap-[0.4375rem] px-4 py-16 text-center"
          >
            <div
              class="relative mb-3.5 grid size-[7.25rem] place-items-center"
              aria-hidden="true"
            >
              <span
                class="absolute inset-0 rounded-full border border-(--solus-accent) opacity-0 [animation:empty-pulse_3.6s_ease-out_infinite] motion-reduce:animate-none motion-reduce:opacity-25"
              ></span>
              <span
                class="absolute inset-0 rounded-full border border-(--solus-accent) opacity-0 [animation:empty-pulse_3.6s_ease-out_infinite] [animation-delay:1.8s] motion-reduce:animate-none motion-reduce:opacity-25"
              ></span>
              <span
                class="relative z-[1] grid size-[5.5rem] place-items-center rounded-full bg-(--solus-accent-light) text-(--solus-accent) [animation:empty-float_3.6s_ease-in-out_infinite] motion-reduce:animate-none"
              >
                <LightningIcon size={44} weight="fill" />
              </span>
            </div>
            <p
              class="text-base font-semibold tracking-[-0.01em] text-(--solus-text-primary)"
            >
              No automations yet.
            </p>
            <p
              class="max-w-[25rem] text-[0.8125rem] leading-[1.55] text-(--solus-text-tertiary)"
            >
              Create a saved prompt that runs on a schedule — or have an agent
              set one up for you.
            </p>
            <button
              type="button"
              class="{newBtnClass} mt-3.5 px-3.5 py-[0.4375rem] text-xs"
              onclick={startCreate}
            >
              <PlusIcon size={13} weight="bold" />
              <span>New automation</span>
            </button>
          </div>
        {:else if automations.length === 0}
          <div
            class="flex flex-col items-center justify-center gap-[0.4375rem] px-4 py-16 text-center"
          >
            <p
              class="text-base font-semibold tracking-[-0.01em] text-(--solus-text-primary)"
            >
              No automations match.
            </p>
            <p
              class="max-w-[25rem] text-[0.8125rem] leading-[1.55] text-(--solus-text-tertiary)"
            >
              Try a different search or filter.
            </p>
          </div>
        {:else}
          {#each automationSections as section (section.id)}
            <div
              class="flex items-center gap-1.5 px-0.5 pb-2 pt-2.5 text-[0.6875rem] font-medium uppercase tracking-[0.08em] text-(--solus-text-tertiary)"
            >
              <span>{section.label}</span>
              <span class="tabular-nums opacity-70">{section.items.length}</span
              >
            </div>
            <ul
              class="flex flex-col gap-0"
              role="list"
              aria-label={section.label}
            >
              {#each section.items as a (a.id)}
                {@const dotTone = !a.enabled
                  ? "paused"
                  : a.lastRunStatus === "failed"
                    ? "error"
                    : a.lastRunStatus === "running"
                      ? "running"
                      : "on"}
                <li>
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <!-- svelte-ignore a11y_click_events_have_key_events -->
                  <div
                    class="group relative flex items-center gap-3 rounded-[0.625rem] px-3 py-2.5 cursor-pointer transition-colors duration-150 ease-in-out hover:bg-(--solus-accent-light) focus-visible:bg-(--solus-accent-light) focus-visible:outline-none {a.enabled
                      ? ''
                      : 'opacity-60'}"
                    role="button"
                    tabindex="0"
                    onclick={() => startEdit(a)}
                    onkeydown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        startEdit(a);
                      }
                    }}
                  >
                    <!-- Status dot — pure indicator (state is changed via the
                         explicit pause/resume control on the right). -->
                    <span
                      class="flex-shrink-0 grid place-items-center w-3.5 h-3.5"
                      role="img"
                      aria-label={dotTone === "running"
                        ? "Running"
                        : dotTone === "error"
                          ? "Last run failed"
                          : dotTone === "paused"
                            ? "Paused"
                            : "Active"}
                      title={dotTone === "running"
                        ? "Running"
                        : dotTone === "error"
                          ? "Last run failed"
                          : dotTone === "paused"
                            ? "Paused"
                            : "Active"}
                    >
                      <span
                        class="block w-2 h-2 rounded-full {dotTone === 'paused'
                          ? 'border border-(--solus-text-tertiary)'
                          : dotTone === 'error'
                            ? 'bg-(--solus-status-error)'
                            : dotTone === 'running'
                              ? 'bg-(--solus-accent) animate-pulse'
                              : 'bg-(--solus-text-secondary)'}"
                      ></span>
                    </span>

                    <!-- Name + source folder -->
                    <div class="flex-1 min-w-0 flex items-baseline gap-2">
                      <span
                        class="text-[0.8125rem] font-medium tracking-[-0.01em] text-(--solus-text-primary) truncate"
                        >{a.name}</span
                      >
                      <span
                        class="flex-shrink-0 text-[0.75rem] text-(--solus-text-tertiary)"
                        >{folderLabel(a.action.cwd)}</span
                      >
                      {#if a.createdBy.kind === "agent"}
                        <span
                          class="shrink-0 rounded bg-(--solus-surface-hover) px-1 py-px text-[0.5625rem] font-semibold uppercase tracking-[0.06em] text-(--solus-text-tertiary)"
                          title="Created by an agent">agent</span
                        >
                      {/if}
                    </div>

                    <!-- Right: schedule + secondary actions, then the always-visible
                         pause / resume / stop state control. -->
                    <div class="flex-shrink-0 flex items-center gap-1.5">
                      <div class="relative flex items-center justify-end">
                        <span
                          class="text-[0.75rem] text-(--solus-text-tertiary) whitespace-nowrap transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0"
                        >
                          {triggerSummary(a.trigger)}
                        </span>
                        <div
                          class="absolute right-0 flex items-center gap-0.5 opacity-0 pointer-events-none transition-opacity duration-150 group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto"
                        >
                          <button
                            type="button"
                            class="{iconBtnClass} {a.favorite
                              ? 'text-[var(--solus-art-2,#c9883f)] [&:hover:not(:disabled)]:bg-[color-mix(in_srgb,var(--solus-art-2,#c9883f)_14%,transparent)] [&:hover:not(:disabled)]:text-[var(--solus-art-2,#c9883f)]'
                              : ''}"
                            onclick={(e) => toggleFavorite(a, e)}
                            aria-label={a.favorite ? "Unstar" : "Star"}
                            aria-pressed={a.favorite}
                            title={a.favorite ? "Unstar" : "Star"}
                          >
                            <StarIcon
                              size={13}
                              weight={a.favorite ? "fill" : "regular"}
                            />
                          </button>
                          <button
                            type="button"
                            class={iconBtnClass}
                            onclick={(e) => runNow(a, e)}
                            disabled={!a.enabled ||
                              a.lastRunStatus === "running"}
                            aria-label="Run now"
                            title="Run now"
                          >
                            <PlayIcon size={13} weight="fill" />
                          </button>
                          <button
                            type="button"
                            class={iconBtnClass}
                            onclick={(e) => {
                              e.stopPropagation();
                              startEdit(a);
                            }}
                            aria-label="Edit"
                            title="Edit"
                          >
                            <PencilSimpleIcon size={13} />
                          </button>
                          <button
                            type="button"
                            class={dangerIconBtnClass}
                            onclick={(e) => deleteAutomation(a, e)}
                            aria-label="Delete"
                            title="Delete"
                          >
                            <TrashIcon size={13} />
                          </button>
                        </div>
                      </div>

                      {#if a.lastRunStatus === "running"}
                        <button
                          type="button"
                          class="{stateBtnClass} bg-[color-mix(in_srgb,var(--solus-status-error,#e53e3e)_12%,transparent)] text-[var(--solus-status-error,#e53e3e)] hover:bg-[color-mix(in_srgb,var(--solus-status-error,#e53e3e)_20%,transparent)] hover:text-[var(--solus-status-error,#e53e3e)] focus-visible:bg-[color-mix(in_srgb,var(--solus-status-error,#e53e3e)_20%,transparent)] focus-visible:text-[var(--solus-status-error,#e53e3e)]"
                          onclick={(e) => cancelRun(a, e)}
                          aria-label="Stop run"
                          title="Stop this run"
                        >
                          <StopIcon size={13} weight="fill" />
                        </button>
                      {:else if a.enabled}
                        <button
                          type="button"
                          class={stateBtnClass}
                          onclick={(e) => toggleEnabled(a, e)}
                          aria-label="Pause automation"
                          title="Pause — stop running on schedule"
                        >
                          <PauseIcon size={13} weight="fill" />
                        </button>
                      {:else}
                        <button
                          type="button"
                          class="{stateBtnClass} text-(--solus-accent) hover:bg-(--solus-accent-light) hover:text-(--solus-accent) focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-accent)"
                          onclick={(e) => toggleEnabled(a, e)}
                          aria-label="Resume automation"
                          title="Resume — run on schedule again"
                        >
                          <PlayIcon size={13} weight="fill" />
                        </button>
                      {/if}
                    </div>
                  </div>
                </li>
              {/each}
            </ul>
          {/each}
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  @keyframes empty-pulse {
    0% {
      transform: scale(0.7);
      opacity: 0.45;
    }
    70% {
      opacity: 0;
    }
    100% {
      transform: scale(1.15);
      opacity: 0;
    }
  }
  @keyframes empty-float {
    0%,
    100% {
      transform: translateY(0);
    }
    50% {
      transform: translateY(-0.1875rem);
    }
  }
</style>
