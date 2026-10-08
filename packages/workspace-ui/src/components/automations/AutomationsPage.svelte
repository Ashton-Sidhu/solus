<script lang="ts">
  import { NEW_CHAT_DIRECTORY } from "@solus/contracts/chat";
  import { tick, untrack } from "svelte";
  import { Star as StarIcon } from "@lucide/svelte";
  import type { Automation } from "@solus/contracts/types";
  import {
    getWorkspaceContext,
    getClientShellContext,
    runtime,
    serversStore,
    projectsStore,
    normalizeProjectRoot,
  } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { PAGE_SECONDARY_BTN } from "../../lib/page-chrome";
  import {
    ListEmpty,
    ListFilterBar,
    ListFilterGroup,
    ListProjectFilter,
    ListSortMenu,
    ListGroup,
    ListPage,
    ListSkeleton,
    syncStamp,
    type ListFilterSpec,
    type ListProjectOption,
  } from "../ui/list-page";
  import { folderLabel } from "./lib/automation-format";
  import { automationListMachineIds } from "./lib/automation-machines";
  import AutomationBuilder from "./AutomationBuilder.svelte";
  import AutomationContextMenu from "./AutomationContextMenu.svelte";
  import AutomationLaunchpad from "./AutomationLaunchpad.svelte";
  import AutomationRow from "./AutomationRow.svelte";
  import {
    automationProjectKey,
    automationProjectOptions,
    automationsInScope,
  } from "./lib/automation-projects";
  import { paneActions } from "../ui/lib/pane-actions.svelte";
  import type { InlinePageProps } from "../ui/lib/pane-surface";

  let { paneId }: InlinePageProps = $props();

  const session = getWorkspaceContext();
  const pane = paneActions(() => paneId);
  const shell = getClientShellContext();
  const store = session.automationsStore;
  // The project the page is scoped to, one row for every checkout of it on
  // any host (docs/plans/project-model.md §5); null for every project.
  const scopeKey = $derived(
    session.projectPageScope.kind === "project"
      ? session.projectPageScope.key
      : null,
  );
  // Automations live on execution machines, never on the Solus API that is
  // the primary at a Solus Cloud origin (plan 004, item 2). A project can be
  // checked out on more than one of them, so the page lists from every
  // connected one and a project scope filters by project.
  const machineIds = $derived(
    automationListMachineIds(serversStore.executionServers),
  );
  // One key per machine set, so a status tick that rebuilds the same list
  // does not reload it.
  const machineKey = $derived(machineIds.join("\n"));
  const hostItems = $derived(store.itemsForHosts(machineIds));

  const open = $derived(session.router.at("automations"));
  // The wide layout opens the builder in a side pane. The mobile layout keeps
  // editing inline because it has no companion pane.
  const canShowBuilderPane = $derived(shell.hasCompanionPanes);

  // view: the list, or the create/edit builder.
  type View =
    | { kind: "list" }
    | { kind: "edit"; automation: Automation | null };
  let view = $state<View>({ kind: "list" });

  // ── Project filter ──
  // The page starts with the complete catalog. Its project facet comes from
  // that catalog, not from open tabs, so every automation always has a choice.
  const projectKeyByAutomationId = $derived(
    new Map(
      hostItems.map((automation) => [
        automation.id,
        automationProjectKey(
          automation.action.cwd,
          store.hostFor(automation.id),
          (serverId, path) => projectsStore.projectKeyFor(serverId, path),
        ),
      ]),
    ),
  );
  const projectKeyOf = (automation: Automation) =>
    projectKeyByAutomationId.get(automation.id) ?? automation.action.cwd;
  // The catalog also knows projects these machines hold with no automations
  // yet, so the filter offers "scope to a project before automating it".
  const projectOptions = $derived(
    automationProjectOptions(
      projectKeyByAutomationId.values(),
      [
        ...session.logicalProjects
          .filter((project) =>
            project.checkouts.some((checkout) =>
              machineIds.includes(checkout.serverId),
            ),
          )
          .map((project) => project.key),
        ...(scopeKey ? [scopeKey] : []),
      ],
      (projectKeys) => session.projectOptionsFor(projectKeys),
    ),
  );
  const projectLabelByKey = $derived(
    new Map(projectOptions.map((option) => [option.key, option.label])),
  );
  // A new automation needs a folder on a host: the scope's checkout of its
  // project, the Chat marker under Chat, else the input bar's folder.
  const launchpadProjectPath = $derived(
    scopeKey === NEW_CHAT_DIRECTORY
      ? NEW_CHAT_DIRECTORY
      : (session.projectPageScope.kind === "project"
          ? session.projectPageScope.checkout?.projectRoot
          : null) ?? session.galleryProjectPath,
  );

  // ── Command bar: search + status filter + favourites + sort ──
  type StatusFilter = "all" | "active" | "paused" | "archived";
  type SortMode = "recent" | "name";
  type StatusSectionId =
    | "running"
    | "failed"
    | "active"
    | "paused"
    | "archived";
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
    { id: "archived", label: "Archived" },
  ];

  let query = $state("");
  let statusFilter = $state<StatusFilter>("all");
  let showStarred = $state(false);
  let sortMode = $state<SortMode>("recent");
  let searchEl = $state<HTMLInputElement | null>(null);
  // The highlighted row — what ↵ opens and ␣ pauses. Arrow keys only move it;
  // nothing is fetched or mounted until a row is actually opened.
  let selectedId = $state<string | null>(null);
  let collapsedGroups = $state<Record<string, boolean>>({});
  let automationContextMenu = $state<{
    automation: Automation;
    x: number;
    y: number;
  } | null>(null);

  // Tick the clock so "next run in 4 hr" and the rows' ages keep counting down
  // instead of freezing at load.
  let now = $state(Date.now());
  $effect(() => {
    if (!open) return;
    const interval = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(interval);
  });

  // Paths and automation ids are host-local data, so each row keeps its own
  // machine (`store.hostFor`) and a project scope keeps only its machine's rows.
  const scoped = $derived(
    automationsInScope(hostItems, session.projectPageScope, projectKeyOf),
  );

  const counts = $derived.by(() => {
    let active = 0;
    let paused = 0;
    let archived = 0;
    for (const automation of scoped) {
      if (automation.archivedAt) archived++;
      else if (automation.enabled) active++;
      else paused++;
    }
    return { all: scoped.length - archived, active, paused, archived };
  });

  const statusSegments = $derived([
    { value: "all", label: "All", count: counts.all },
    { value: "archived", label: "Archived", count: counts.archived },
    {
      value: "active",
      label: "Active",
      short: "On",
      count: counts.active,
    },
    {
      value: "paused",
      label: "Paused",
      short: "Off",
      count: counts.paused,
    },
  ] satisfies Array<{
    value: StatusFilter;
    label: string;
    short?: string;
    count: number;
  }>);

  const isInitialLoading = $derived(store.isInitialLoadingHosts(machineIds));
  // The zero-state owns the page, so the header hides its New button while it
  // shows. The command bar stays while there is a project to switch to: it
  // holds the project scope, the only way out of an empty project.
  const showEmpty = $derived(!isInitialLoading && hostItems.length === 0);
  const synced = syncStamp(() => store.loading);

  // Flat, filtered, sorted list. Sections are built from this result so search,
  // starred-only, and status tabs still apply before grouping.
  const automations = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return scoped
      .filter((a) => {
        if ((statusFilter === "archived") !== !!a.archivedAt) return false;
        if (statusFilter === "active" && !a.enabled) return false;
        if (statusFilter === "paused" && a.enabled) return false;
        if (showStarred && !a.favorite) return false;
        if (!q) return true;
        const projectLabel = projectLabelByKey.get(projectKeyOf(a));
        return (
          a.name.toLowerCase().includes(q) ||
          folderLabel(a.action.cwd).toLowerCase().includes(q) ||
          projectLabel?.toLowerCase().includes(q) === true
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
      const sectionId: StatusSectionId = a.archivedAt
        ? "archived"
        : a.lastRunStatus === "running"
          ? "running"
          : a.lastRunStatus === "failed"
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

  const listFilters = $derived<ListFilterSpec[]>([
    {
      key: "starred",
      label: "Starred",
      icon: StarIcon,
      count: scoped.filter((a) => a.favorite).length,
      active: showStarred,
      toggle: () => (showStarred = !showStarred),
    },
  ]);

  $effect(() => {
    if (open) {
      // Reset the command bar each time the page opens.
      query = "";
      statusFilter = "all";
      showStarred = false;
      sortMode = "recent";
      selectedId = null;
      // Deep-link: jump straight into one automation's editor when the route
      // names one (e.g. from the project panel or a "Sent via automation"
      // badge); the bare route lands on the list.
      const focusId = session.router.params("automations")?.automationId;
      if (focusId) {
        const scopeServerIds = untrack(() => machineIds);
        void store.loadHosts(scopeServerIds).then(() => {
          const target = store
            .itemsForHosts(scopeServerIds)
            .find((automation) => automation.id === focusId);
          view = target
            ? { kind: "edit", automation: target }
            : { kind: "list" };
        });
      } else {
        view = { kind: "list" };
        if (!runtime.shouldSuppressFocus) {
          void tick().then(() => searchEl?.focus());
        }
      }
    }
  });

  // Reload when the page opens and whenever the set of machines changes.
  $effect(() => {
    if (!open || !machineKey) return;
    void store.loadHosts(untrack(() => machineIds));
  });

  useScope("automations", { active: () => open });
  // The one explicit way to scope the page to the input bar's project; the tab
  // in focus never does it by itself (docs/plans/project-model.md §5).
  useKeybinding("automations.current-project", () => {
    session.scopePageToCurrentProject();
  }, { enabled: () => open });
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
    if (canShowBuilderPane) {
      session.openAutomationBuilder(null);
      return;
    }
    view = { kind: "edit", automation: null };
  }
  function startEdit(a: Automation) {
    if (canShowBuilderPane) {
      session.openAutomationBuilder(a.id);
      return;
    }
    view = { kind: "edit", automation: a };
  }
  function backToList() {
    view = { kind: "list" };
  }

  /** Open an automation the launchpad just created without letting an old facet
   *  hide it when the user returns to the list. */
  function openSeeded(a: Automation) {
    session.setProjectPageScope({ kind: "all" });
    query = "";
    statusFilter = "all";
    showStarred = false;
    startEdit(a);
  }

  function selectProject(option: ListProjectOption | null) {
    if (option && !option.available) return;
    if (option) session.scopePageToProject(option.key);
    else session.setProjectPageScope({ kind: "all" });
    selectedId = null;
    // The search was written against the project being left, so it goes with
    // it — the same trade Tasks, Pull requests and the Workspace make.
    query = "";
  }

  let observedProjectKey = "";
  $effect(() => {
    if (!open) return;
    const nextKey = scopeKey ?? "all";
    if (!observedProjectKey) {
      observedProjectKey = nextKey;
      return;
    }
    if (observedProjectKey === nextKey) return;
    observedProjectKey = nextKey;
    selectedId = null;
    query = "";
    void tick().then(() => searchEl?.focus());
  });

  function removeProject(option: ListProjectOption) {
    void projectsStore.removeProject(option.key);
  }

  function clearFilters() {
    session.setProjectPageScope({ kind: "all" });
    query = "";
    statusFilter = "all";
    showStarred = false;
    searchEl?.focus();
  }

  /** Clears what the Filters badge counts. The search stays unless the project scope changes. */
  function clearMenuFilters() {
    statusFilter = "all";
    showStarred = false;
    if (scopeKey) selectProject(null);
  }

  async function toggleEnabled(a: Automation, e?: Event) {
    e?.stopPropagation();
    await store.setEnabled(a.id, !a.enabled);
  }

  async function runNow(a: Automation, e?: Event) {
    e?.stopPropagation();
    await store.runNow(a.id);
  }

  async function cancelRun(a: Automation, e?: Event) {
    e?.stopPropagation();
    await store.cancel(a.id);
  }

  async function toggleFavorite(a: Automation, e?: Event) {
    e?.stopPropagation();
    await store.setFavorite(a.id, !a.favorite);
  }

  function deleteAutomation(a: Automation, e?: Event) {
    e?.stopPropagation();
    // Hide the row immediately, then offer a brief undo window. The on-disk
    // delete is deferred until the toast commits (matches document delete).
    if (!store.softRemove(a.id)) return;
    toasts.undo("Automation deleted", () => store.restorePending(), {
      onDismiss: () => void store.commitPending(),
    });
  }

  function openAutomationContextMenu(
    event: MouseEvent,
    automation: Automation,
  ) {
    event.preventDefault();
    event.stopPropagation();
    selectedId = automation.id;
    automationContextMenu = {
      automation,
      x: event.clientX,
      y: event.clientY,
    };
  }

  // ── List keyboard nav ── the four keys the footer rail advertises.
  function onListKeydown(e: KeyboardEvent) {
    const inField =
      e.target instanceof HTMLElement && e.target.closest("input, textarea");
    const selected = automations.find((a) => a.id === selectedId) ?? null;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (automations.length === 0) return;
      e.preventDefault();
      const index = selected ? automations.indexOf(selected) : -1;
      const next =
        e.key === "ArrowDown"
          ? Math.min(index + 1, automations.length - 1)
          : Math.max(index - 1, 0);
      selectedId = automations[next].id;
    } else if (e.key === "Enter" && selected && !inField) {
      e.preventDefault();
      startEdit(selected);
    } else if (e.key === " " && selected && !inField) {
      e.preventDefault();
      void store.setEnabled(selected.id, !selected.enabled);
    }
  }
</script>

{#snippet filterBar()}
  <ListFilterBar
    bind:query
    bind:searchEl
    compactText
    placeholder="Search automations…"
    filters={listFilters}
    activeCount={Number(statusFilter !== "all") + Number(!!scopeKey)}
    onClearFilters={clearMenuFilters}
  >
    {#snippet filterContent()}
      <ListProjectFilter
        projects={projectOptions}
        activeKey={scopeKey ?? ""}
        emptyLabel="All projects"
        onSelect={selectProject}
        onSelectAll={() => selectProject(null)}
        onSelectCurrent={() => session.scopePageToCurrentProject()}
        onRemoveProject={removeProject}
        footerNote="Switching keeps filters, clears search"
      />
      <ListFilterGroup
        label="Status"
        options={statusSegments}
        selected={[statusFilter]}
        onChange={(next) => (statusFilter = next[0])}
      />
    {/snippet}
    {#snippet trailing()}
      <ListSortMenu
        bind:value={sortMode}
        options={SORT_OPTIONS}
        ariaLabel="Sort automations"
      />
    {/snippet}
  </ListFilterBar>
{/snippet}

{#if open}
  <div
    class="@container relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background text-chrome-dense focus:outline-none"
    role="dialog"
    aria-label="Automations"
    tabindex="-1"
  >
    {#if view.kind === "edit"}
      <!-- ── Full-page automation detail / editor ── -->
      <AutomationBuilder automation={view.automation} onDone={backToList} />
    {:else}
      <ListPage
        page="automations"
        onRefresh={() => void store.loadHosts(machineIds)}
        refreshing={store.loading}
        syncedAt={synced.at}
        primaryAction={showEmpty
          ? undefined
          : { label: "New automation", shortcut: "⌘N", run: startCreate }}
        onClose={close}
        toolbarFilters
        filters={showEmpty && projectOptions.length === 0 ? undefined : filterBar}
      >
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div onkeydown={onListKeydown} role="presentation">
          {#if isInitialLoading}
            <ListSkeleton plan={[[52, 38, 44, 30]]} identWidth={110} />
          {:else if !showEmpty && automations.length === 0}
            <ListEmpty title="No automations match.">
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
            </ListEmpty>
          {:else}
            <div
              class="grid h-7 grid-cols-[20px_minmax(140px,330px)_minmax(148px,1fr)_156px_64px] items-center gap-x-[11px] pr-2 pl-2.5 text-xs font-normal text-muted-foreground uppercase @max-[44rem]:grid-cols-[20px_minmax(100px,1fr)_128px_64px]"
              aria-hidden="true"
            >
              <span></span>
              <span>Automation</span>
              <span class="whitespace-nowrap">Runs in</span>
              <span class="text-right @max-[44rem]:hidden">Schedule</span>
              <span class="text-right whitespace-nowrap">Last run</span>
            </div>
            {#each automationSections as section (section.id)}
              <ListGroup
                label={section.label}
                count={section.items.length}
                open={!collapsedGroups[section.id]}
                onToggle={() =>
                  (collapsedGroups = {
                    ...collapsedGroups,
                    [section.id]: !collapsedGroups[section.id],
                  })}
              >
                <ul
                  class="flex flex-col"
                  role="list"
                  aria-label={section.label}
                >
                  {#each section.items as a (a.id)}
                    <li>
                      <AutomationRow
                        automation={a}
                        projectLabel={projectLabelByKey.get(projectKeyOf(a)) ??
                          folderLabel(a.action.cwd)}
                        projectPath={normalizeProjectRoot(a.action.cwd)}
                        serverId={store.hostFor(a.id)}
                        {now}
                        selected={selectedId === a.id}
                        onOpen={startEdit}
                        onToggleEnabled={toggleEnabled}
                        onRunNow={runNow}
                        onCancelRun={cancelRun}
                        onToggleFavorite={toggleFavorite}
                        onDelete={deleteAutomation}
                        onContextMenu={openAutomationContextMenu}
                      />
                    </li>
                  {/each}
                </ul>
              </ListGroup>
            {/each}
          {/if}

          <!-- ── Launchpad: describe it, or start from a template. Shown in both
               states — a workspace with automations still starts new ones here. -->
          {#if !isInitialLoading}
            <div
              class={showEmpty
                ? "pt-[22px]"
                : "pt-[30px]"}
            >
              <AutomationLaunchpad
                projectPath={launchpadProjectPath}
                onOpen={openSeeded}
                onCreateBlank={startCreate}
              />
            </div>
          {/if}
        </div>
      </ListPage>

      {#if automationContextMenu}
        {@const menuAutomation = automationContextMenu.automation}
        <AutomationContextMenu
          x={automationContextMenu.x}
          y={automationContextMenu.y}
          automation={menuAutomation}
          onEdit={() => startEdit(menuAutomation)}
          onRunNow={() => void runNow(menuAutomation)}
          onCancelRun={() => void cancelRun(menuAutomation)}
          onToggleEnabled={() => void toggleEnabled(menuAutomation)}
          onToggleFavorite={() => void toggleFavorite(menuAutomation)}
          onDelete={() => deleteAutomation(menuAutomation)}
          onClose={() => (automationContextMenu = null)}
        />
      {/if}
    {/if}
  </div>
{/if}
