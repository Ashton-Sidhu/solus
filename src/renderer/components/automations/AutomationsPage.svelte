<script lang="ts">
  import { tick } from "svelte";
  import {
    PlusIcon,
    StarIcon,
    ArrowsClockwiseIcon,
  } from "phosphor-svelte";
  import type { Automation } from "../../../shared/types";
  import { getWorkspaceContext, getWindowContext, runtime, toasts } from "../../contexts";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { matchesOpenProjects } from "../../lib/sessionUtils";
  import { PAGE_SECONDARY_BTN } from "../../lib/page-chrome";
  import PageEmpty from "../ui/PageEmpty.svelte";
  import { folderLabel } from "./lib/automation-format";
  import AutomationBuilder from "./AutomationBuilder.svelte";
  import AutomationLaunchpad from "./AutomationLaunchpad.svelte";
  import AutomationRow from "./AutomationRow.svelte";
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

  const open = $derived(session.router.at("automations"));
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
      // Deep-link: jump straight into one automation's editor when the route
      // names one (e.g. from the project panel or a "Sent via automation"
      // badge); the bare route lands on the list.
      const focusId = session.router.params("automations")?.automationId;
      if (focusId) {
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
    session.router.close("automations");
    requestInputFocus();
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
      {#snippet automationStats()}
        <span class="flex items-center gap-1.5">
          <span
            class="size-1.5 shrink-0 rounded-full bg-(--solus-art-positive)"
            aria-hidden="true"
          ></span>
          <span class="tabular-nums">{counts.active} active</span>
        </span>
        <span class="opacity-40" aria-hidden="true">·</span>
        <span class="tabular-nums">{counts.paused} paused</span>
        <span class="opacity-40" aria-hidden="true">·</span>
        <span class="tabular-nums">{counts.all} total</span>
      {/snippet}
      <PageShell>
        <PageHeader
          title="Automations"
          subtitle={automationStats}
          size="large"
          onClose={close}
        >
          {#snippet icon()}
            <!-- The cycle, not a bolt: an automation is recurring work, not fast work. -->
            <ArrowsClockwiseIcon size={11} weight="bold" />
          {/snippet}
          {#snippet actions()}
            {#if !showEmpty}
              <button
                type="button"
                class="inline-flex h-[2.125rem] shrink-0 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-primary pr-[0.9375rem] pl-3 text-[0.78125rem] font-semibold text-primary-foreground transition-[filter] duration-100 hover:brightness-[1.07]"
                onclick={startCreate}
                data-testid="automation-new"
              >
                <PlusIcon size={12} weight="bold" />
                <span>New</span>
              </button>
            {/if}
          {/snippet}
        </PageHeader>

        <!-- ── Command bar: search + status segments + starred + sort ── -->
        {#if !showEmpty}
          <div class="flex min-w-0 flex-wrap items-center gap-2.5 pt-1 pb-4">
            <SearchField
              bind:ref={searchEl}
              bind:value={query}
              placeholder="Search automations…"
              class="h-8 min-w-0 flex-1 basis-0 rounded-lg border-0 bg-muted px-3 py-0 @max-[44rem]:basis-0"
            />
            <SegmentedControl
              variant="bar"
              options={statusSegments}
              isActive={(v) => statusFilter === v}
              onSelect={(v) => (statusFilter = v)}
              ariaLabel="Filter by status"
            />
            <div class="ml-auto flex shrink-0 items-center gap-2">
              <button
                type="button"
                class="inline-flex size-[2.125rem] shrink-0 cursor-pointer items-center justify-center rounded-[0.5625rem] border transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] {showStarred
                  ? 'border-transparent bg-secondary text-secondary-foreground'
                  : 'border-[color-mix(in_srgb,var(--solus-container-border)_80%,transparent)] bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground'}"
                onclick={() => (showStarred = !showStarred)}
                aria-pressed={showStarred}
                aria-label="Starred automations"
                title="Starred automations"
              >
                <StarIcon size={14} weight={showStarred ? "fill" : "regular"} />
              </button>
              <SortMenu
                bind:value={sortMode}
                options={SORT_OPTIONS}
                ariaLabel="Sort automations"
                class="h-[2.125rem] gap-1.5 rounded-[0.5625rem] border border-[color-mix(in_srgb,var(--solus-container-border)_80%,transparent)] bg-transparent px-2.5 py-0 text-[12.5px] font-normal text-muted-foreground hover:bg-muted hover:text-foreground"
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
                <Skeleton class="size-7 shrink-0 rounded-[0.5rem] bg-(--solus-surface-hover)" style="animation-delay: {i * 120}ms" />
                <span class="flex min-w-0 flex-1 flex-col gap-1.5">
                  <Skeleton class="h-2.5 rounded-full bg-(--solus-surface-hover)" style="width: {width}%; animation-delay: {i * 120}ms" />
                  <Skeleton class="h-2 rounded-full bg-(--solus-surface-hover) opacity-60" style="width: {Math.round(width * 0.6)}%; animation-delay: {i * 120}ms" />
                </span>
                <Skeleton class="ml-auto h-2.5 w-20 shrink-0 rounded-full bg-(--solus-surface-hover)" style="animation-delay: {i * 120}ms" />
              </div>
            {/each}
          </div>
        {:else if counts.all === 0}
          <!-- No CTA of its own — the launchpad directly below is the call to
               action, so a button here would only compete with it. -->
          <div class="flex max-w-[40rem] flex-col gap-3.5 pt-3.5 pb-2">
            <span
              class="text-[0.65625rem] font-semibold tracking-[0.13em] text-[color-mix(in_srgb,var(--solus-text-tertiary)_85%,transparent)] uppercase"
              >Nothing running yet</span
            >
            <h2
              class="text-[1.8125rem] leading-[1.15] font-semibold tracking-[-0.032em] text-pretty text-(--solus-text-primary)"
            >
              What would you rather not do again next week?
            </h2>
            <p class="text-sm leading-[1.65] text-pretty text-(--solus-text-tertiary)">
              Say it once. An agent runs it against your repo on the cadence you
              pick, and leaves a run you can review.
            </p>
          </div>
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
                  <li>
                    <AutomationRow
                      automation={a}
                      onOpen={startEdit}
                      onToggleEnabled={toggleEnabled}
                      onRunNow={runNow}
                      onCancelRun={cancelRun}
                      onToggleFavorite={toggleFavorite}
                      onDelete={deleteAutomation}
                    />
                  </li>
                {/each}
              </ul>
            {/each}
          </div>
        {/if}

        <!-- ── Launchpad: describe it, or start from a template. Shown in both
             states — a workspace with automations still starts new ones here. -->
        {#if !isInitialLoading}
          <div class={showEmpty ? "pt-8.5" : "pt-12"}>
            <AutomationLaunchpad onOpen={startEdit} onCreateBlank={startCreate} />
          </div>
        {/if}
      </PageShell>
    {/if}
  </div>
{/if}
