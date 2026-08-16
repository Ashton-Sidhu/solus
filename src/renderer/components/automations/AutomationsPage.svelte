<script lang="ts">
  import { serverConnections } from "@client-core/server-connections";
  import { tick } from "svelte";
  import { StarIcon } from "phosphor-svelte";
  import type { Automation } from "../../../shared/types";
  import {
    getWorkspaceContext,
    getWindowContext,
    runtime,
    serversStore,
  } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import SegmentedControl from "../ui/SegmentedControl.svelte";
  import SortMenu from "../ui/SortMenu.svelte";
  import {
    ListEmpty,
    ListFilterBar,
    ListGroup,
    ListPage,
    ListSkeleton,
    type ListFilterSpec,
    type ListSummaryStat,
  } from "../ui/list-page";
  import { folderLabel, relativeTime } from "./lib/automation-format";
  import AutomationBuilder from "./AutomationBuilder.svelte";
  import AutomationContextMenu from "./AutomationContextMenu.svelte";
  import AutomationLaunchpad from "./AutomationLaunchpad.svelte";
  import AutomationProjectFilter from "./AutomationProjectFilter.svelte";
  import AutomationRow from "./AutomationRow.svelte";
  import {
    automationProject,
    automationProjects,
  } from "./lib/automation-projects";

  const session = getWorkspaceContext();
  const windowCtx = getWindowContext();
  const store = session.automationsStore;
  // The full-page catalog has no narrower owner, so the new-work default host
  // is its explicit scope; with no host connected there is nothing to list.
  const selectedServerId = $derived(
    serverConnections.defaultServerId() ??
      serverConnections.connectedServerIds()[0] ??
      null,
  );
  const hostItems = $derived(
    selectedServerId ? store.itemsForHost(selectedServerId) : [],
  );

  const open = $derived(session.router.at("automations"));
  // Editor mode opens the builder in the side panel; pill mode has no pane, so it
  // keeps editing inline within this overlay.
  const isEditorMode = $derived(windowCtx.viewMode === "editor");

  // view: the list, or the create/edit builder.
  type View =
    | { kind: "list" }
    | { kind: "edit"; automation: Automation | null };
  let view = $state<View>({ kind: "list" });

  // ── Project filter ──
  // The page starts with the complete catalog. Its project facet comes from
  // that catalog, not from open tabs, so every automation always has a choice.
  let selectedProjectKey = $state<string | null>(null);
  const projects = $derived(
    automationProjects(
      hostItems,
      session.openProjects,
      session.staticInfo?.workspacePath,
      (automation) => store.hostFor(automation.id),
      (serverId) => serversStore.hostFor(serverId)?.label ?? serverId,
    ),
  );
  const selectedProject = $derived(
    projects.find((project) => project.key === selectedProjectKey) ?? null,
  );

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

  // The visible universe belongs to the selected host. Paths and automation
  // ids are host-local data, so another connected machine must not leak into
  // this page when the user switches hosts.
  const scoped = $derived(
    selectedProject
      ? hostItems.filter(
          (a) =>
            automationProject(a, store.hostFor(a.id), projects)?.key ===
            selectedProject.key,
        )
      : hostItems,
  );

  const counts = $derived.by(() => {
    let active = 0;
    let paused = 0;
    for (const automation of scoped) {
      if (automation.enabled) active++;
      else paused++;
    }
    return { all: scoped.length, active, paused };
  });

  const statusSegments = $derived(([
    { value: "all", label: "All", count: counts.all },
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
  ] satisfies Array<{ value: StatusFilter; label: string; short?: string; count: number }>));

  const isInitialLoading = $derived(
    !!selectedServerId &&
      !store.hasLoadedHost(selectedServerId) &&
      store.isLoadingHost(selectedServerId),
  );
  // The zero-state owns the page, so the header hides its New button and the
  // command bar (search/filter noise with nothing to filter) while it shows.
  const showEmpty = $derived(!isInitialLoading && hostItems.length === 0);

  // The lead statistic is what the page is for — how much is running unattended
  // — and it is the only coloured text in the header.
  const summary = $derived.by<ListSummaryStat[]>(() => {
    const soonest = scoped
      .filter((a) => a.enabled && a.nextRunAt)
      .map((a) => a.nextRunAt!)
      .sort()[0];
    return [
      { label: `${counts.active} active`, tint: "running" },
      { label: `${counts.paused} paused` },
      {
        label: soonest
          ? `next run ${relativeTime(soonest, now)}`
          : "nothing scheduled",
      },
    ];
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
        const projectLabel = automationProject(
          a,
          store.hostFor(a.id),
          projects,
        )?.label;
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
      selectedProjectKey = null;
      selectedId = null;
      // Deep-link: jump straight into one automation's editor when the route
      // names one (e.g. from the project panel or a "Sent via automation"
      // badge); the bare route lands on the list.
      const focusId = session.router.params("automations")?.automationId;
      if (focusId && selectedServerId) {
        const scopeServerId = selectedServerId;
        void store.loadAll(scopeServerId).then(() => {
          const target = store
            .itemsForHost(scopeServerId)
            .find((automation) => automation.id === focusId);
          view = target
            ? { kind: "edit", automation: target }
            : { kind: "list" };
        });
      } else {
        view = { kind: "list" };
        if (selectedServerId) void store.loadAll(selectedServerId);
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

  /** Open an automation the launchpad just created without letting an old facet
   *  hide it when the user returns to the list. */
  function openSeeded(a: Automation) {
    selectedProjectKey = null;
    query = "";
    statusFilter = "all";
    showStarred = false;
    startEdit(a);
  }

  function selectProject(projectKey: string | null) {
    selectedProjectKey = projectKey;
    selectedId = null;
  }

  function clearFilters() {
    selectedProjectKey = null;
    query = "";
    statusFilter = "all";
    showStarred = false;
    searchEl?.focus();
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

  function openAutomationContextMenu(event: MouseEvent, automation: Automation) {
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
    placeholder="Search automations…"
    filters={listFilters}
  >
    {#snippet trailing()}
      <SegmentedControl
        variant="bar"
        compact
        options={statusSegments}
        isActive={(v) => statusFilter === v}
        onSelect={(v) => (statusFilter = v)}
        ariaLabel="Filter by status"
      />
      <SortMenu
        bind:value={sortMode}
        options={SORT_OPTIONS}
        ariaLabel="Sort automations"
        class="h-7 gap-1.5 rounded-lg px-2.5 text-[0.8125rem] font-normal text-muted-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] hover:text-foreground"
      />
      <AutomationProjectFilter
        {projects}
        value={selectedProject?.key ?? null}
        allCount={hostItems.length}
        onSelect={selectProject}
      />
    {/snippet}
  </ListFilterBar>
{/snippet}

{#if open}
  <div
    class="@container relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background focus:outline-none"
    role="dialog"
    aria-label="Automations"
    tabindex="-1"
  >
    {#if view.kind === "edit"}
      <!-- ── Full-page automation detail / editor ── -->
      <AutomationBuilder automation={view.automation} onDone={backToList} />
    {:else}
      <ListPage
        title="Automations"
        {summary}
        primaryAction={showEmpty
          ? undefined
          : { label: "New automation", shortcut: "⌘N", run: startCreate }}
        onClose={close}
        filters={showEmpty ? undefined : filterBar}
      >
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div onkeydown={onListKeydown} role="presentation">
          {#if isInitialLoading}
            <ListSkeleton plan={[[52, 38, 44, 30]]} identWidth={110} />
          {:else if showEmpty}
            <!-- No CTA of its own — the launchpad directly below is the call to
                 action, so a button here would only compete with it. -->
            <div
              class="mt-3.5 flex max-w-[600px] flex-col gap-2.5 rounded-2xl bg-[var(--wash-1)] px-6 py-[26px]"
            >
              <span
                class="text-xs font-normal text-muted-foreground uppercase"
                >Nothing running yet</span
              >
              <h2
                class="text-[1.5rem] leading-[1.35] font-medium text-pretty"
              >
                What would you rather not do again next week?
              </h2>
              <p
                class="max-w-[56ch] text-[0.8125rem] leading-[1.65] text-pretty text-muted-foreground"
              >
                Say it once. An agent runs it against your repo on the cadence
                you pick, and leaves a run you can review.
              </p>
            </div>
          {:else if automations.length === 0}
            <ListEmpty title="No automations match.">
              Try a different search or filter.
              {#snippet actions()}
                <Button
                  type="button"
                  class="inline-flex h-8 cursor-pointer items-center rounded-lg border-0 bg-muted px-3 text-[0.8125rem] font-medium text-muted-foreground transition-colors hover:text-foreground"
                  onclick={clearFilters}
                >
                  Clear filters
                </Button>
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
                    {@const project = automationProject(
                      a,
                      store.hostFor(a.id),
                      projects,
                    )}
                    <li>
                      <AutomationRow
                        automation={a}
                        projectLabel={project?.label ?? folderLabel(a.action.cwd)}
                        projectPath={project?.projectPath ?? a.action.cwd}
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
            <div class={showEmpty ? "pt-[22px]" : "pt-[30px]"}>
              <AutomationLaunchpad
                projectPath={selectedProject?.projectPath ?? session.galleryProjectPath}
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
