<script lang="ts">
  import { tick } from "svelte";
  import {
    PlusIcon,
    PlayIcon,
    PauseIcon,
    StopIcon,
    TrashIcon,
    PencilSimpleIcon,
    StarIcon,
    LightningIcon,
  } from "phosphor-svelte";
  import type { Automation } from "../../../shared/types";
  import { getWorkspaceContext, getWindowContext, runtime, toasts } from "../../contexts";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { matchesOpenProjects } from "../../lib/sessionUtils";
  import {
    PAGE_PRIMARY_BTN,
    PAGE_ICON_BTN,
    PAGE_SECONDARY_BTN,
  } from "../../lib/page-chrome";
  import PageEmpty from "../ui/PageEmpty.svelte";
  import { triggerSummary, relativeTime } from "./lib/automation-format";
  import AutomationBuilder from "./AutomationBuilder.svelte";
  import PageShell from "../ui/PageShell.svelte";
  import PageHeader from "../ui/PageHeader.svelte";
  import SearchField from "../ui/search-field";
  import SegmentedControl from "../ui/SegmentedControl.svelte";
  import SectionLabel from "../ui/SectionLabel.svelte";
  import SortMenu from "../ui/SortMenu.svelte";
  import { Skeleton } from "../ui/skeleton";

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
  let searchEl = $state<HTMLInputElement | HTMLTextAreaElement | null>(null);

  const stateBtnClass =
    "grid size-7 shrink-0 cursor-pointer place-items-center rounded-[0.4375rem] border-0 bg-transparent text-(--solus-text-tertiary) transition-[background-color,color] duration-100 ease-in-out hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary) focus-visible:outline-none [@media(pointer:coarse)]:size-11";
  const dangerIconBtnClass = `${PAGE_ICON_BTN} [&:hover:not(:disabled)]:bg-[color-mix(in_srgb,var(--solus-status-error,#e53e3e)_14%,transparent)] [&:hover:not(:disabled)]:text-[var(--solus-status-error,#e53e3e)]`;

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

  const statusSegments = $derived([
    { value: "all" as StatusFilter, label: "All", count: counts.all },
    { value: "active" as StatusFilter, label: "Active", short: "On", count: counts.active },
    { value: "paused" as StatusFilter, label: "Paused", short: "Off", count: counts.paused },
  ]);

  const isInitialLoading = $derived(!store.loaded && store.loading);
  // The zero-state owns the primary CTA, so the header hides its New button and
  // the command bar (search/filter noise with nothing to filter) while it shows.
  const showEmpty = $derived(!isInitialLoading && counts.all === 0);

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

  function clearFilters() {
    query = "";
    statusFilter = "all";
    showStarred = false;
    searchEl?.focus();
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
      <PageShell onClose={close}>
        <PageHeader
          title="Automations"
          subtitle="Saved prompts that run on a schedule."
        >
          {#snippet icon()}
            <LightningIcon size={18} weight="fill" />
          {/snippet}
          {#snippet actions()}
            {#if !showEmpty}
              <button
                type="button"
                class={PAGE_PRIMARY_BTN}
                onclick={startCreate}
                data-testid="automation-new"
              >
                <PlusIcon size={13} weight="bold" />
                <span>New</span>
              </button>
            {/if}
          {/snippet}
        </PageHeader>

        <!-- ── Command bar: search + status segments + starred + sort ── -->
        {#if !showEmpty}
          <div class="flex flex-wrap items-center gap-2 pb-4">
            <SearchField
              bind:ref={searchEl}
              bind:value={query}
              placeholder="Search automations…"
            />
            <SegmentedControl
              options={statusSegments}
              isActive={(v) => statusFilter === v}
              onSelect={(v) => (statusFilter = v)}
              ariaLabel="Filter by status"
            />
            <div class="ml-auto flex shrink-0 items-center gap-1">
              <button
                type="button"
                class="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg border-0 transition-[background-color,color] duration-100 ease-in-out focus-visible:bg-(--solus-accent-light) focus-visible:outline-none [@media(pointer:coarse)]:size-10 {showStarred
                  ? 'bg-[color-mix(in_srgb,var(--solus-art-2,#c9883f)_14%,transparent)] text-[var(--solus-art-2,#c9883f)]'
                  : 'bg-transparent text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary)'}"
                onclick={() => (showStarred = !showStarred)}
                aria-pressed={showStarred}
                aria-label="Starred automations"
                title="Starred automations"
              >
                <StarIcon size={13} weight={showStarred ? "fill" : "regular"} />
              </button>
              <SortMenu
                bind:value={sortMode}
                options={SORT_OPTIONS}
                ariaLabel="Sort automations"
              />
            </div>
          </div>
        {/if}

        <!-- ── Body: the list ── -->
        {#if isInitialLoading}
          <div
            class="-mx-3 flex flex-col gap-1 pt-1"
            role="status"
            aria-label="Loading automations"
          >
            {#each [28, 38, 22, 32] as width, i (i)}
              <div class="flex items-center gap-3 rounded-[0.625rem] px-3 py-3" aria-hidden="true">
                <Skeleton class="size-2 shrink-0 rounded-full bg-(--solus-surface-hover)" style="animation-delay: {i * 120}ms" />
                <span class="flex min-w-0 flex-1 flex-col gap-1.5">
                  <Skeleton class="h-2.5 rounded-full bg-(--solus-surface-hover)" style="width: {width}%; animation-delay: {i * 120}ms" />
                  <Skeleton class="h-2 rounded-full bg-(--solus-surface-hover) opacity-60" style="width: {Math.round(width * 0.6)}%; animation-delay: {i * 120}ms" />
                </span>
                <Skeleton class="ml-auto h-2.5 w-20 shrink-0 rounded-full bg-(--solus-surface-hover)" style="animation-delay: {i * 120}ms" />
              </div>
            {/each}
          </div>
        {:else if counts.all === 0}
          <PageEmpty icon={LightningIcon} title="No automations yet.">
            Create a saved prompt that runs on a schedule — or have an agent
            set one up for you.
            {#snippet actions()}
              <button
                type="button"
                class={PAGE_PRIMARY_BTN}
                onclick={startCreate}
                data-testid="automation-new"
              >
                <PlusIcon size={13} weight="bold" />
                <span>New automation</span>
              </button>
            {/snippet}
          </PageEmpty>
        {:else if automations.length === 0}
          <PageEmpty title="No automations match.">
            Try a different search or filter.
            {#snippet actions()}
              <button
                type="button"
                class={PAGE_SECONDARY_BTN}
                onclick={clearFilters}
              >
                Clear filters
              </button>
            {/snippet}
          </PageEmpty>
        {:else}
          <div class="flex flex-col">
            {#each automationSections as section (section.id)}
              <SectionLabel label={section.label} count={section.items.length} />
              <ul
                class="-mx-3 flex flex-col"
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
                  {@const lastRunLabel =
                    a.lastRunStatus === "running"
                      ? "Running now"
                      : a.lastRunStatus === "failed" && a.lastRunAt
                        ? `Failed ${relativeTime(a.lastRunAt)}`
                        : a.lastRunAt
                          ? `Last ran ${relativeTime(a.lastRunAt)}`
                          : ""}
                  <li>
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <!-- svelte-ignore a11y_click_events_have_key_events -->
                    <div
                      class="group relative flex items-center gap-3 rounded-[0.625rem] px-3 py-3 cursor-pointer transition-colors duration-150 ease-in-out hover:bg-(--solus-surface-hover) focus-visible:bg-(--solus-accent-light) focus-visible:outline-none {a.enabled
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

                      <!-- Name + agent badge, with folder and last-run state
                           on a quieter second line. -->
                      <div class="min-w-0 flex-1">
                        <div class="flex items-baseline gap-2">
                          <span
                            class="text-[0.8125rem] font-medium tracking-[-0.01em] text-(--solus-text-primary) truncate"
                            >{a.name}</span
                          >
                          {#if a.createdBy.kind === "agent"}
                            <span
                              class="shrink-0 rounded bg-(--solus-surface-hover) px-1 py-px text-[0.5625rem] font-semibold uppercase tracking-[0.06em] text-(--solus-text-tertiary)"
                              title="Created by an agent">agent</span
                            >
                          {/if}
                        </div>
                        <div
                          class="mt-0.5 flex items-center gap-1.5 text-xs text-(--solus-text-tertiary)"
                        >
                          <span class="truncate">{folderLabel(a.action.cwd)}</span
                          >
                          {#if lastRunLabel}
                            <span class="opacity-50" aria-hidden="true">·</span>
                            <span
                              class="shrink-0 {a.lastRunStatus === 'failed'
                                ? 'text-[var(--solus-status-error,#e53e3e)]'
                                : a.lastRunStatus === 'running'
                                  ? 'text-(--solus-accent)'
                                  : ''}">{lastRunLabel}</span
                            >
                          {/if}
                        </div>
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
                              class="{PAGE_ICON_BTN} {a.favorite
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
                              class={PAGE_ICON_BTN}
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
                              class={PAGE_ICON_BTN}
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
          </div>
        {/if}
      </PageShell>
    {/if}
  </div>
{/if}

