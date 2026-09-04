<script lang="ts">
  import { localApi } from "@solus/client-core/local-api";
  import { tick, untrack } from "svelte";
  import { fly } from "svelte/transition";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import {
    GitPullRequest as GitPullRequestIcon,
    RefreshCw as ArrowsClockwiseIcon,
    BookOpenText as BookOpenTextIcon,
    LoaderCircle as CircleNotchIcon,
    Play as PlayIcon,
    User as UserIcon,
    Users as UsersIcon,
    Tag as TagIcon,
    FilePenLine as DraftIcon,
    MessageSquareCheck as ReviewIcon,
    CircleCheck as ChecksIcon,
    CircleDashed as PendingIcon,
    CircleSlash as NoReviewIcon,
    CircleX as FailureIcon,
    EyeOff as HideIcon,
    GitPullRequestDraft as DraftOnlyIcon,
    Layers as AllIcon,
    CircleAlert as WarningCircleIcon,
  } from "@lucide/svelte";
  import type { PullRequest } from "@solus/contracts/providers";
  import { projectScopeOf, type IpcContext } from "@solus/contracts/types";
  import {
    getWorkspaceContext,
    getPullRequestsContext,
    getSettingsContext,
    runtime,
    getSessionSidebarStore,
    projectCatalog,
    mergeProjectOptions,
    projectRefKey,
    serversStore,
  } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { hostKey } from "@solus/client-core/host-key";
  import { subscribeAllHosts } from "@solus/client-core/host-events";
  import { Button } from "../ui/button";
  import PageEmpty from "../ui/PageEmpty.svelte";
  import {
    InboxRow,
    ListEmpty,
    ListGroup,
    ListPage,
    ListRailRow,
    syncStamp,
    VirtualList,
    LIST_GROUP_HEADER_HEIGHT,
    inboxRowHeight,
    listRowHeight,
    virtualGroupItems,
    type ListPageView,
    type ListProjectOption,
  } from "../ui/list-page";
  import { isStackedPane } from "../../lib/pane-width";
  import { filterPrFacets, filterPrs, sortPrs, type PrSortMode } from "./lib/pr-utils";
  import {
    showsPrDetailPanel,
    showsPrPageSkeleton,
    type ScopeSwitchPhase,
  } from "./lib/pr-list-loading";
  import {
    PR_LIST_ROW_HEIGHT,
    PR_STATUS_OPTIONS,
    OPEN_PR_STATUS_KEYS,
    prFetchScope,
    prGroups,
    prInboxGroups,
    prStatusOf,
    type PrRowContext,
  } from "./lib/prs-list-view";
  import { labelChipColor } from "../ui/labels/label-color";
  import type { PrProject } from "../../contexts/prs/prs.store.svelte";
  import type { PrReviewTab } from "../../contexts/prs/pr-view.svelte";
  import { groupStackedPrRows } from "./lib/stack-grouping";
  import {
    flattenQualifiedProjects,
    qualifiedKeyOf,
    qualifiedStackParentOf,
    type PrTarget,
    type QualifiedProject,
  } from "./lib/pr-cross-project";
  import GithubConnectionRequired from "./GithubConnectionRequired.svelte";
  import {
    prInboxFailure,
    type PrInboxFailure,
  } from "./lib/pr-inbox-failure";
  import PrDetailPanel from "./PrDetailPanel.svelte";
  import PrListRow from "./PrListRow.svelte";
  import PrContextMenu from "./PrContextMenu.svelte";
  import PrsPageSkeleton from "./PrsPageSkeleton.svelte";
  import PrListToolbar from "./PrListToolbar.svelte";
  import type { PrFilterGroup } from "./lib/pr-filter-menu";
  import { paneActions } from "../ui/lib/pane-actions.svelte";
  import type { InlinePageProps } from "../ui/lib/pane-surface";

  let { paneId }: InlinePageProps = $props();

  const session = getWorkspaceContext();
  const pullRequests = getPullRequestsContext();
  const pane = paneActions(() => paneId);
  const settings = getSettingsContext();
  const sessionSidebar = getSessionSidebarStore();
  const store = pullRequests.projects;
  const stacks = pullRequests.stacks;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const open = $derived(session.router.at("prs"));

  // ── List state ──
  // Everything that describes *how the list was left* lives in the store, not
  // here: opening a pull request replaces this page, so these locals would be
  // destroyed on every open and the list would forget the review it just
  // returned from. `view` is the exception — which tab of the page you are on
  // is a property of the visit, not of the reading position.
  let view = $state<ListPageView>("global");
  const listView = $derived(pullRequests.view.listView);
  let searchEl = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLDivElement | undefined>();
  let contentHeight = $state(0);
  let pageWidth = $state(0);
  let stacksReady = $state(false);
  const viewerLogins = new SvelteMap<string, string>();
  let prContextMenu = $state<{
    pr: PullRequest;
    x: number;
    y: number;
  } | null>(null);

  // Tick the clock so relative row times age instead of freezing at load.
  let now = $state(Date.now());
  $effect(() => {
    if (!open) return;
    const interval = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(interval);
  });

  // ── Review multi-select ──
  // Checked PRs narrow the Review action: with any checked, the header button
  // opens Review Mode over just those instead of every filtered PR. Keyed by
  // the row's qualified key (not a bare number) — All projects can hold the
  // same PR number from two different repos.
  const reviewSelection = new SvelteSet<string>();

  // ── Project scope ──
  // The page receives a host-qualified scope before navigation replaces the
  // draft, chat, or project page that supplied it.
  const pageProject = $derived(
    session.projectPageScope.kind === "project"
      ? session.projectPageScope.project
      : null,
  );
  const inputRun = $derived(session.activeRun);
  const inputProjectPath = $derived(
    inputRun?.gitContext?.repoRoot ?? inputRun?.workingDirectory ?? null,
  );
  const isInboxView = $derived(view === "inbox");
  /** The projects the footer paginates: every one the inbox is showing, or just
   *  the one the single-project view is on. Each pages itself. */

  // A switch is a different list, not a refresh of this one, so the rows on
  // screen stop being the truth the moment the scope changes. The scope effect
  // drives this through to `idle` once the scope that replaced them has read.
  let scopeSwitch = $state<ScopeSwitchPhase>("idle");

  // The sidebar's live projects are all on whichever host is selected there;
  // the catalog spans every host the client has ever recorded a project on.
  const sidebarServerId = $derived(serverConnections.defaultServerId());
  const projectOptions = $derived<ListProjectOption[]>(
    mergeProjectOptions(
      [
        // With no default host there is nothing to attribute a sidebar project
        // to; the catalog still carries its own host per entry.
        sidebarServerId
          ? sessionSidebar.projectSummaries
              .filter((project) => project.projectKey !== "~")
              .map((project) => ({
                serverId: sidebarServerId,
                projectRoot: project.projectKey,
                label: project.label,
              }))
          : [],
        projectCatalog.entries,
      ],
      (serverId) => serversStore.statusFor(serverId) !== "offline",
      (serverId) => serversStore.hostFor(serverId)?.label ?? serverId,
    ).map((option) => ({
      key: option.key,
      projectKey: option.projectRoot,
      serverId: option.serverId,
      label: option.label,
      available: option.available,
      historyOnly: !sessionSidebar.projectSummaries.some(
        (project) => project.projectKey === option.projectRoot,
      ),
    })),
  );
  const scopedProjectPath = $derived(
    pageProject?.projectRoot ?? inputProjectPath,
  );
  // A pinned project has no checkout of its own, so its repo root is the only
  // directory to read from; the input bar's project can name a worktree.
  const scopedCheckoutPath = $derived(
    pageProject?.projectRoot ??
      inputRun?.gitContext?.worktreePath ??
      inputRun?.workingDirectory ??
      null,
  );
  // The list's one project reads through `PrsStore`; the inbox aggregator uses
  // one `(api, serverId, ctx)` per project.
  // Null when nothing is connected to read from: a host is a precondition for
  // loading, not something to assume, so every caller below guards rather than
  // letting `primaryApi()` throw.
  const prsServerId = $derived(
    pageProject?.serverId ??
      inputRun?.serverId ??
      serverConnections.defaultServerId(),
  );
  // The switcher's own reading of the scope: the pin when there is one, the
  // input bar's project resolved against its host otherwise.
  const activeProjectOptionKey = $derived(
    pageProject
      ? projectRefKey(pageProject)
      : (prsServerId && scopedProjectPath
        ? projectRefKey({
            serverId: prsServerId,
            projectRoot: scopedProjectPath,
          })
        : ""),
  );
  const prsApi = $derived(
    prsServerId ? serverConnections.apiFor(prsServerId) : null,
  );
  function prsCtx(): IpcContext {
    return scopedCheckoutPath
      ? session.ctxForDirectory(scopedCheckoutPath)
      : session.ctx;
  }

  /** The one project the single-project view is showing, or null with no host.
   *  The store is a map and holds no notion of "current" — the page does. */
  const shown = $derived(store.at(prsServerId, scopedProjectPath));
  /** The projects the footer paginates. Each pages itself. */
  const paginating = $derived(isInboxView ? store.all : shown ? [shown] : []);

  // ── Inbox: the all-project aggregate read ──
  // Only projects on a host that is connected right now. A saved host that has
  // never dialed keeps its request queued in the transport with nothing to age
  // it out, and one of those inside the inbox's bounded worker pool blocks
  // every project behind it — which is how All projects ends up waiting on a
  // machine that is not there while the project you can actually read sits
  // unfetched. The picker still offers every project; only the fan-out is
  // narrowed, and the effect below re-runs as hosts connect.
  const inboxProjects = $derived<PrProject[]>(
    projectOptions
      .filter((option) => serversStore.statusFor(option.serverId) === "online")
      .map((option) => ({
        serverId: option.serverId,
        projectRoot: option.projectKey,
        label: option.label,
        api: serverConnections.apiFor(option.serverId),
        ctx: session.ctxForDirectory(option.projectKey),
      })),
  );
  // Each reachable project, carrying whatever the PR store has loaded for it.
  // The targets are the authoritative set and keep their catalog order; the
  // store supplies the rows.
  const qualifiedProjects = $derived<QualifiedProject[]>(
    inboxProjects.map((project) => ({
      serverId: project.serverId,
      projectRoot: project.projectRoot,
      label: project.label,
      api: project.api,
      ctx: project.ctx,
      items: store.at(project.serverId, project.projectRoot)?.items ?? [],
    })),
  );
  const qualified = $derived(flattenQualifiedProjects(qualifiedProjects));
  const aggregateKeyFor = $derived(qualifiedKeyOf(qualified.byPr));
  const aggregateStackParentOf = $derived(qualifiedStackParentOf(stacks, qualified.byPr));
  const inboxHasMore = $derived(store.all.some((project) => project.hasMore));
  const inboxLoadingMore = $derived(store.all.some((project) => project.loadingMore));
  const inboxLoading = $derived(store.all.some((project) => project.loading));
  const activeRefreshing = $derived(isInboxView ? inboxLoading : (shown?.loading ?? false));

  const SORT_OPTIONS: { value: PrSortMode; label: string }[] = [
    { value: "created", label: "Created" },
    { value: "updated", label: "Updated" },
    { value: "effort", label: "Effort" },
  ];

  // The statuses the list and the inbox are showing, and the fetch scope they
  // imply — merged and closed pull requests are a separate page on the host, so
  // asking for them has to widen the load before anything can be filtered.
  const statuses = $derived(new Set(listView.statusKeys));
  const fetchScope = $derived(prFetchScope(listView.statusKeys));
  // The item list this visit is reading: one project's cache, or every
  // project's last-safe snapshot merged together.
  const activeItems = $derived(
    isInboxView
      ? qualified.items
      : scopedProjectPath
        ? (shown?.items ?? [])
        : [],
  );
  // A host that is still dialing is not an empty inbox: until it settles the
  // page is still on its way, so the skeleton holds rather than the list
  // claiming there is nothing to read.
  const inboxHostsConnecting = $derived(
    projectOptions.some(
      (option) => serversStore.statusFor(option.serverId) === "connecting",
    ),
  );
  // Is the scope in view reading right now — a first load, a refresh, or a
  // page. Says nothing about what the page should show; `showsPrPageSkeleton`
  // decides that.
  const activeScopeReading = $derived(
    isInboxView ? inboxLoading || inboxHostsConnecting : (shown?.loading ?? false),
  );
  const activeLoading = $derived(
    isInboxView ? activeScopeReading && activeItems.length === 0 : activeScopeReading,
  );
  // A failed project keeps its last-safe rows, so a failure is only visible if
  // it is said out loud: a banner when something did load, the page's own
  // surface when nothing did.
  const inboxFailure = $derived(
    isInboxView
      ? prInboxFailure(store.all, activeItems.length > 0)
      : ({ kind: "none", placement: "none" } satisfies PrInboxFailure),
  );

  // ── The shared row grammar's view of a PR ──
  // `isMine` needs the connected viewer's login; until `loadViewer` lands it
  // falls back to "nobody is me", which under-fills the Yours filter rather than
  // mislabelling someone else's PR as yours. `checks` resolves through the PR's
  // own project in All projects — a bare PR number cannot tell two repos apart.
  const rowContext = $derived<PrRowContext>({
    checks: (pr) => {
      if (!isInboxView) {
        return prsServerId ? pullRequests.checks.summaryFor(prsServerId, prsCtx(), pr.number) : undefined;
      }
      const owner = qualified.byPr.get(pr);
      return owner ? pullRequests.checks.summaryFor(owner.serverId, owner.ctx, pr.number) : undefined;
    },
    guideStatus: (pr) => {
      const target = targetFor(pr);
      return target
        ? pullRequests.guides.statusFor(target.serverId, target.ctx, pr.number)
        : undefined;
    },
    isMine: (pr) => {
      const owner = isInboxView ? qualified.byPr.get(pr) : undefined;
      const serverId = owner?.serverId ?? prsServerId;
      const projectPath = owner?.projectRoot ?? scopedProjectPath;
      if (!serverId || !projectPath) return false;
      const login = viewerLogins.get(hostKey(serverId, projectPath));
      return !!login && pr.author.toLowerCase() === login.toLowerCase();
    },
  });

  const searched = $derived(
    sortPrs(
      filterPrs(activeItems, listView.query, fetchScope),
      listView.sortMode,
    ),
  );

  function viewerLoginFor(pr: PullRequest): string | null {
    const owner = isInboxView ? qualified.byPr.get(pr) : undefined;
    const serverId = owner?.serverId ?? prsServerId;
    const projectPath = owner?.projectRoot ?? scopedProjectPath;
    return serverId && projectPath
      ? (viewerLogins.get(hostKey(serverId, projectPath)) ?? null)
      : null;
  }

  function currentChecksState(pr: PullRequest): "passing" | "pending" | "failing" | null {
    const checks = rowContext.checks(pr);
    return checks?.headSha === pr.headSha ? checks.state : null;
  }

  const filtered = $derived.by(() => {
    return filterPrFacets(
      searched.filter((pr) => statuses.has(prStatusOf(pr))),
      listView,
      { viewerLogin: viewerLoginFor, checksState: currentChecksState },
    );
  });
  const showPageSkeleton = $derived(
    showsPrPageSkeleton(scopeSwitch, activeLoading, filtered.length),
  );

  // Stacks never cross a repository. In All projects each PR's stack parent
  // comes from its own project's graph (`aggregateStackParentOf`); scoped to
  // one project, it is that project's single graph as before.
  const stackGraph = $derived(
    !isInboxView && scopedProjectPath && settings.stackedPrsEnabled && stacksReady && prsServerId
      ? stacks.graphFor(prsServerId, scopedProjectPath)
      : null,
  );
  const groupedRows = $derived(groupStackedPrRows(filtered, stackGraph));
  // The row says what it is stacked on inside its own hover reveal, so the
  // relationship reads without the list having to indent anything.
  const stackParents = $derived(
    new Map(
      groupedRows
        .flatMap((row) => row.parent === null ? [] : [[row.pr.number, row.parent] as const]),
    ),
  );
  const stackParentOf = $derived(
    isInboxView ? aggregateStackParentOf : (pr: PullRequest) => stackParents.get(pr.number) ?? null,
  );
  const rowKeyOf = $derived(isInboxView ? aggregateKeyFor : undefined);

  const groups = $derived(prGroups(filtered, rowContext, now, stackParentOf, rowKeyOf));
  // The row's verb picks the tab it lands on: a row that says Review opens on
  // the diff, everything else on Activity.
  const inboxGroups = $derived.by(() => {
    const groups = prInboxGroups(filtered, rowContext, now, {
      review: (pr) => selectPr(pr, "diff"),
      open: (pr) => selectPr(pr),
      openExternal: openPrExternal,
    }, statuses, rowKeyOf);
    return groups.map((group) => ({
      ...group,
      rows: group.rows.map((row) => {
        const projectLabel = qualified.byKey.get(row.key)?.label;
        return projectLabel
          ? { ...row, context: `${projectLabel} · ${row.context}` }
          : row;
      }),
    }));
  });
  const inboxVirtualItems = $derived(
    virtualGroupItems(
      inboxGroups,
      (row) => row.key,
      (group) => !listView.collapsedGroups[`inbox:${group.key}`],
    ),
  );
  const globalVirtualItems = $derived(
    virtualGroupItems(
      groups,
      (row) => row.key,
      (group) => !listView.collapsedGroups[group.key],
    ),
  );
  const inboxActiveKey = $derived(
    inboxVirtualItems.find(
      (item) => item.kind === "row" && item.row.key === selectedKey,
    )?.key ?? null,
  );
  const globalActiveKey = $derived(
    globalVirtualItems.find(
      (item) => item.kind === "row" && item.row.key === selectedKey,
    )?.key ?? null,
  );
  const unreadCount = $derived(
    inboxGroups.find((g) => g.key === "needs")?.rows.length ?? 0,
  );

  const authorOptions = $derived.by(() => {
    const authors = new Map<string, { avatarUrl: string; count: number }>();
    for (const pr of searched) {
      const current = authors.get(pr.author);
      if (current) current.count += 1;
      else if (pr.author) authors.set(pr.author, { avatarUrl: pr.authorAvatarUrl, count: 1 });
    }
    return [
      { value: "", label: "Anyone", count: searched.length },
      ...Array.from(authors, ([author, facts]) => ({
        value: author,
        label: author,
        avatarUrl: facts.avatarUrl,
        count: facts.count,
      })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    ];
  });
  const labelOptions = $derived.by(() => {
    const labels = new Map<string, { color: string; count: number }>();
    for (const pr of searched) {
      for (const label of pr.labels) {
        const current = labels.get(label.name);
        if (current) current.count += 1;
        else labels.set(label.name, { color: labelChipColor(label.color), count: 1 });
      }
    }
    return [
      { value: "", label: "Any", count: searched.length },
      ...Array.from(labels, ([label, facts]) => ({
        value: label,
        label,
        color: facts.color,
        count: facts.count,
      })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    ];
  });
  const stateValue = $derived(
    listView.statusKeys.length === PR_STATUS_OPTIONS.length
      ? "all"
      : listView.statusKeys.includes("open")
        ? "open"
        : (listView.statusKeys[0] ?? "all"),
  );
  const filterGroups = $derived<PrFilterGroup[]>([
    {
      key: "state", label: "State", icon: GitPullRequestIcon,
      value: stateValue, valueLabel: stateValue === "all" ? "All" : `${stateValue[0].toUpperCase()}${stateValue.slice(1)}`,
      active: stateValue !== "open",
      options: [
        { value: "open", label: "Open" }, { value: "merged", label: "Merged" },
        { value: "closed", label: "Closed" }, { value: "all", label: "All" },
      ],
      select: (value) => onStatusChange(value === "open" ? [...OPEN_PR_STATUS_KEYS] : value === "all" ? PR_STATUS_OPTIONS.map((option) => option.value) : [value]),
    },
    {
      key: "involvement", label: "Involvement", icon: UsersIcon,
      value: listView.involvement,
      valueLabel: ({ all: "All", created: "Created", assigned: "Assigned", "review-requested": "Review requested" })[listView.involvement],
      active: listView.involvement !== "all",
      options: [
        { value: "all", label: "All" }, { value: "created", label: "Created by you" },
        { value: "assigned", label: "Assigned to you" }, { value: "review-requested", label: "Review requested from you" },
      ], select: (value) => (listView.involvement = value as typeof listView.involvement),
    },
    {
      key: "author", label: "Author", icon: UserIcon,
      value: listView.author ?? "", valueLabel: listView.author ?? "Anyone",
      active: listView.author !== null, searchable: true, options: authorOptions,
      select: (value) => (listView.author = value || null),
    },
    {
      key: "labels", label: "Labels", icon: TagIcon,
      value: listView.label ?? "", valueLabel: listView.label ?? "Any",
      active: listView.label !== null, options: labelOptions,
      select: (value) => (listView.label = value || null),
    },
    {
      key: "draft", label: "Draft", icon: DraftIcon,
      value: listView.draft, valueLabel: ({ all: "All", ready: "Ready", draft: "Draft" })[listView.draft],
      active: listView.draft !== "all",
      options: [
        { value: "all", label: "All", icon: AllIcon },
        { value: "draft", label: "Drafts only", icon: DraftOnlyIcon },
        { value: "ready", label: "Hide drafts", icon: HideIcon },
      ],
      select: (value) => (listView.draft = value as typeof listView.draft),
    },
    {
      key: "review", label: "Review", icon: ReviewIcon,
      value: listView.review,
      valueLabel: ({ all: "All", approved: "Approved", "changes-requested": "Changes requested", "review-required": "Review required", "no-reviews": "No reviews" })[listView.review],
      active: listView.review !== "all",
      options: [
        { value: "all", label: "All", icon: AllIcon },
        { value: "approved", label: "Approved", icon: ChecksIcon },
        { value: "changes-requested", label: "Changes requested", icon: FailureIcon },
        { value: "review-required", label: "Review required", icon: PendingIcon },
        { value: "no-reviews", label: "No reviews", icon: NoReviewIcon },
      ],
      select: (value) => (listView.review = value as typeof listView.review),
    },
    {
      key: "checks", label: "Checks", icon: ChecksIcon,
      value: listView.checks, valueLabel: ({ all: "All", passing: "Passing", pending: "Running", failing: "Failing" })[listView.checks],
      active: listView.checks !== "all",
      options: [
        { value: "all", label: "All", icon: AllIcon },
        { value: "passing", label: "Passing", icon: ChecksIcon },
        { value: "failing", label: "Failing", icon: FailureIcon },
      ],
      select: (value) => (listView.checks = value as typeof listView.checks),
    },
  ]);

  // How much is waiting on you used to be restated over the list; the inbox
  // segment carries that count now, and the list's own group headers carry the
  // rest — so the head keeps two rows instead of three.
  const synced = syncStamp(() => activeRefreshing);

  const listNavigationItems = $derived(groupedRows.map((row) => row.pr));
  // Every row's identity, list-wide — unique across projects in All projects.
  const keyOf = $derived((pr: PullRequest) => rowKeyOf?.(pr) ?? String(pr.number));

  // Publish the visible order so the review's crumb switcher and its `n of N`
  // stepper walk exactly these rows, in exactly this order. Written from the
  // page because this is where the filters and the stack grouping resolve.
  // Meaningful for the single-project stepper only — All projects keeps its
  // own local selection below, since `prView.listOrder` is bare PR numbers.
  $effect(() => {
    if (isInboxView) return;
    const order = listNavigationItems.map((pr) => pr.number);
    untrack(() => (pullRequests.view.listOrder = order));
  });

  // All projects keeps its own reading position: `PrsStore.listView` is reset
  // only on a *project* scope change and is keyed by bare number, which two
  // repos' identical PR numbers cannot share safely.
  let aggregateSelectedKey = $state<string | null>(null);
  let aggregateOpenKey = $state<string | null>(null);

  const selectedKey = $derived(
    isInboxView
      ? aggregateSelectedKey
      : (listView.selectedNumber !== null ? String(listView.selectedNumber) : null),
  );
  const openKey = $derived(
    isInboxView
      ? aggregateOpenKey
      : (listView.openNumber !== null ? String(listView.openNumber) : null),
  );

  function prByKey(key: string): PullRequest | undefined {
    return isInboxView
      ? qualified.byKey.get(key)?.pr
      : (shown?.items ?? []).find((pr) => String(pr.number) === key);
  }

  /** Which `(api, serverId, ctx)` a row's actions route through — the page's
   *  single scope, or that row's own project in All projects. Null when no
   *  host is connected to route to, so callers skip rather than throw. */
  function targetFor(pr: PullRequest): PrTarget | null {
    const owner = isInboxView ? qualified.byPr.get(pr) : undefined;
    if (owner) return { api: owner.api, serverId: owner.serverId, ctx: owner.ctx }
    if (!prsApi || !prsServerId) return null;
    return { api: prsApi, serverId: prsServerId, ctx: prsCtx() };
  }

  const selectedPr = $derived(selectedKey ? (prByKey(selectedKey) ?? null) : null);

  // ── The detail panel ──
  // A pull request comes out from the side of the list rather than replacing it:
  // the rows stay on screen so the queue is still readable while one item is
  // being reviewed. Below the width where both fit, the panel covers the list
  // instead — a 380px column beside a 380px review is neither.
  const openPr = $derived(openKey ? (prByKey(openKey) ?? null) : null);
  const openTarget = $derived(openPr ? targetFor(openPr) : null);
  const openPanel = $derived(
    openPr && openTarget ? { pr: openPr, target: openTarget } : null,
  );
  const panelOpen = $derived(
    showsPrDetailPanel(openPr !== null, openTarget !== null),
  );
  const roomForSplit = $derived(pageWidth >= 1040);
  // The record rung, for the one decision a container query cannot make: the
  // virtualiser is told a row's height as a number. Same 30rem the stylesheet
  // uses, so the layout and the positions cannot disagree.
  const recordRows = $derived(isStackedPane(pageWidth));
  const panelFullScreen = $derived(
    panelOpen && (listView.panelFullScreen || !roomForSplit),
  );
  const splitList = $derived(panelOpen && !panelFullScreen);

  function closePanel() {
    clearPanelState();
    void tick().then(() => {
      const selectedRow = listEl?.querySelector<HTMLElement>(
        '[data-selected="true"]',
      );
      if (selectedRow) selectedRow.focus();
      else searchEl?.focus();
    });
  }

  function clearPanelState() {
    if (isInboxView) aggregateOpenKey = null;
    else listView.openNumber = null;
    listView.panelFullScreen = false;
  }

  function toggleFullScreen() {
    listView.panelFullScreen = !listView.panelFullScreen;
  }

  /** Step to the pull request before or after the open one, in the list's own
   *  order — what J / K and the panel's stepper walk. */
  function stepPanel(delta: number) {
    if (listNavigationItems.length === 0 || openKey === null) return;
    const index = listNavigationItems.findIndex((p) => keyOf(p) === openKey);
    if (index === -1) return;
    const next =
      listNavigationItems[
        (index + delta + listNavigationItems.length) % listNavigationItems.length
      ];
    // Stepping is a move inside one reading session, so it keeps the tab you
    // are reading; only picking a row afresh re-decides that.
    if (next && keyOf(next) !== openKey) selectPr(next, pullRequests.view.tab);
  }

  function openPrExternal(pr: PullRequest) {
    void localApi.openExternal(pr.url);
  }

  function openPrContextMenu(event: MouseEvent, pr: PullRequest) {
    event.preventDefault();
    event.stopPropagation();
    if (isInboxView) aggregateSelectedKey = keyOf(pr);
    else listView.selectedNumber = pr.number;
    prContextMenu = { pr, x: event.clientX, y: event.clientY };
  }

  // ── Data loading ──

  // Opening the page or changing the input-bar project are the only scope
  // triggers this effect should react to. `session.ctx` reads reactive git state
  // (gitContext, changedFiles) that the git watcher churns on every on-disk
  // change, so tracking it here would re-fire loadAll (flipping `loading` back
  // on) and wipe the user's selection. Untrack the body so normal git updates
  // cannot reset the page.
  //
  // The view state is NOT reset here. Opening a pull request replaces this
  // page, so every return from a review re-runs this effect — resetting would
  // throw away the scroll position, group collapse and selection the design
  // requires to survive the round trip.
  const activeScopeKey = $derived(
    prsServerId && scopedProjectPath
      ? hostKey(prsServerId, scopedProjectPath)
      : "",
  );
  let previousActiveScopeKey = "";
  $effect(() => {
    const scopeKey = activeScopeKey;
    const inboxView = isInboxView;
    if (!open) return;
    untrack(() => {
      if (scopeKey && previousActiveScopeKey && scopeKey !== previousActiveScopeKey) {
        pullRequests.view.resetListView();
        reviewSelection.clear();
        beginScopeSwitch();
      }
      previousActiveScopeKey = scopeKey;
      if (!scopeKey && !inboxView) pullRequests.view.resetListView();
      void loadActiveScope();
      restoreReadingPosition();
    });
  });

  /** Holds the skeleton from the moment the scope changes. The rows on screen
   *  belong to the scope just left, so keeping them would show one project's
   *  pull requests under another project's title until the new read lands. The
   *  reads are dispatched in this same flush, so one `tick` is enough to learn
   *  whether there is anything to wait for. */
  function beginScopeSwitch(): void {
    scopeSwitch = "starting";
    void tick().then(() => {
      scopeSwitch = activeScopeReading ? "reading" : "idle";
    });
  }

  // The switch ends when the read it started ends. Only `reading` clears here,
  // so a later refresh of the same scope cannot end a switch, and a switch
  // whose scope had nothing to read has already gone `idle` above.
  $effect(() => {
    if (scopeSwitch === "reading" && !activeScopeReading) scopeSwitch = "idle";
  });

  /** Loads the input-bar project through `PrsStore`. The inbox reads through
   *  the aggregate effect below instead, which follows the hosts that can
   *  answer rather than the ones that happened to be up at page open. */
  /** The project the single-project view is showing, marked as the one on
   *  screen. Null when no host is connected — a real state, not an error. */
  function shownScope() {
    if (!prsApi || !prsServerId) return null;
    const scope = store.get(prsApi, prsServerId, prsCtx());
    pullRequests.view.activeProjectKey = scope.key;
    return scope;
  }

  async function loadActiveScope(): Promise<void> {
    if (isInboxView || !scopedProjectPath) return;
    const api = prsApi;
    const serverId = prsServerId;
    if (!api || !serverId) return;
    const projectPath = scopedProjectPath;
    void shownScope()?.list({ filter: { state: fetchScope } });
    // The host only volunteers checks for the repository the *active tab* is
    // in. This page may be scoped elsewhere, so it asks for its own — or every
    // row would sit with an empty checks slot until that tab happened to match.
    void pullRequests.checks.load(api, serverId, prsCtx()).catch(() => {});
    void store
      .get(api, serverId, prsCtx())
      .loadViewer()
      .then((viewer) => viewerLogins.set(hostKey(serverId, projectPath), viewer.login))
      .catch(() => {});
    stacksReady = false;
    void stacks.load(api, serverId, prsCtx()).then(
      () => (stacksReady = true),
      () => (stacksReady = false),
    );
  }

  // Which hosts are connected changes while the page is open — one finishes
  // dialing, another drops — so the aggregate read is keyed on that set rather
  // than fired once. The body is untracked because `inboxProjects` also carries
  // live git context that the watcher churns on every on-disk change; tracking
  // that would flip the list back to loading under the reader.
  const reachableInboxKey = $derived(
    inboxProjects
      .map((project) => `${project.serverId}\0${project.projectRoot}`)
      .join("\n"),
  );

  $effect(() => {
    if (!open || !isInboxView || reachableInboxKey === "") return;
    untrack(() => {
      stacksReady = true;
      void store.listAll(inboxProjects, { state: fetchScope });
      // Warm every project's stack graph too, so All projects can tell a stack
      // apart from an unrelated pair of PRs from the first paint.
      for (const project of inboxProjects) {
        void stacks.load(project.api, project.serverId, project.ctx).catch(() => {});
        void store
          .get(project.api, project.serverId, project.ctx)
          .loadViewer()
          .then((viewer) => viewerLogins.set(hostKey(project.serverId, project.projectRoot), viewer.login))
          .catch(() => {});
      }
    });
  });

  // Coming back from a review: put the scroller where it was and hand focus to
  // the row that was being read, so the list resumes rather than restarts. A
  // cold open has no remembered row and starts in the search field, as before.
  function restoreReadingPosition() {
    void tick().then(() => {
      if (runtime.shouldSuppressFocus) return;
      const selectedRow = listEl?.querySelector<HTMLElement>(
        '[data-selected="true"]',
      );
      if (selectedRow) selectedRow.focus();
      else searchEl?.focus();
    });
  }

  /** Pins the list to another project. Picking the input bar's own project
   *  releases the pin, so the list goes back to following it. The scope effect
   *  above owns forgetting the old list — it fires on any scope change, whether
   *  it came from here or from the input bar. */
  function selectProject(option: ListProjectOption): void {
    if (!option.available) return;
    // Picking a project out of the inbox's crumb is how you leave the inbox for
    // that project's queue — the crumb stays a path you can walk back up.
    view = "global";
    session.setProjectPageScope({
      kind: "project",
      project: { serverId: option.serverId, projectRoot: option.projectKey },
    });
    aggregateSelectedKey = null;
    aggregateOpenKey = null;
    void tick().then(() => searchEl?.focus());
  }

  function setView(next: ListPageView): void {
    view = next;
    if (next === "inbox") session.setProjectPageScope({ kind: "all" });
  }

  let observedPageScopeKey = "";
  $effect(() => {
    if (!open) return;
    const nextKey = pageProject ? projectRefKey(pageProject) : "all";
    if (observedPageScopeKey === nextKey) return;
    observedPageScopeKey = nextKey;
    view = pageProject ? "global" : "inbox";
    aggregateSelectedKey = null;
    aggregateOpenKey = null;
    reviewSelection.clear();
    void tick().then(() => searchEl?.focus());
  });

  function removeProjectHistory(option: ListProjectOption): void {
    projectCatalog.remove({ serverId: option.serverId, projectRoot: option.projectKey });
  }

  $effect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = subscribeAllHosts(
      "prs.invalidated",
      (emittingServerId, { projectRoot: changedCwd }) => {
        if (!open) return;
        if (isInboxView) {
          if (!inboxProjects.some((project) => project.serverId === emittingServerId && project.projectRoot === changedCwd)) return;
          clearTimeout(timer);
          timer = setTimeout(() => refreshList(), 500);
          return;
        }
        if (emittingServerId !== prsServerId) return;
        const scopedCtx = prsCtx().session;
        const ctxCwd = projectScopeOf(scopedCtx);
        if (changedCwd !== ctxCwd) return;
        clearTimeout(timer);
        timer = setTimeout(() => refreshList(), 500);
      },
    );
    return () => {
      unsub();
      clearTimeout(timer);
    };
  });

  /** Open a pull request in the panel beside the list. The row stays selected,
   *  so closing the panel resumes the list on what was just read. */
  function selectPr(pr: PullRequest, tab?: PrReviewTab) {
    const key = keyOf(pr);
    if (isInboxView) {
      aggregateSelectedKey = key;
      aggregateOpenKey = key;
    } else {
      listView.selectedNumber = pr.number;
      listView.openNumber = pr.number;
    }
    // The row's verb picks the landing tab: a row that says Review opens on the
    // diff, everything else on Activity.
    pullRequests.view.tab = tab ?? "activity";
    const target = targetFor(pr);
    if (!target) return;
    void store.at(target.serverId, projectScopeOf(target.ctx.session))?.loadEfforts([pr.number]);
    store.get(target.api, target.serverId, target.ctx).get(pr.number).prefetch();
  }

  /** Arrow-key movement only highlights. Nothing is fetched or mounted until
   *  Enter opens the row, so walking the list costs no requests. */
  function highlightPr(pr: PullRequest) {
    if (isInboxView) aggregateSelectedKey = keyOf(pr);
    else listView.selectedNumber = pr.number;
    const target = targetFor(pr);
    if (!target) return;
    void store.at(target.serverId, projectScopeOf(target.ctx.session))?.loadEfforts([pr.number]);
  }

  // Checked PRs in the list order they're shown; stale checks (filtered out or
  // no longer loaded) simply drop out.
  const selected = $derived(
    filtered.filter((pr) => reviewSelection.has(keyOf(pr))),
  );
  // Batch Review/Guides need one project's (api, serverId, ctx) — scoped to a
  // project that's already true; All projects only when every checked PR is
  // from the same repository, so a mixed batch never silently picks one host
  // over another.
  const selectedProjects = $derived(
    new Set(selected.map((pr) => (isInboxView ? (qualified.byPr.get(pr)?.serverId ?? "") + "\0" + (qualified.byPr.get(pr)?.projectRoot ?? "") : ""))),
  );
  const selectionSpansProjects = $derived(isInboxView && selectedProjects.size > 1);

  function toggleReviewSelect(pr: PullRequest) {
    const key = keyOf(pr);
    if (reviewSelection.has(key)) reviewSelection.delete(key);
    else reviewSelection.add(key);
  }

  function clearReviewSelection() {
    reviewSelection.clear();
    requestInputFocus();
  }

  function openReviewMode() {
    const items = selected.length > 0 ? selected : filtered;
    if (items.length === 0) return;
    if (selectionSpansProjects) {
      toasts.error("Select pull requests from one project to start a review", {
        description: "Review Mode reviews one repository's checkout at a time.",
      });
      return;
    }
    const target = targetFor(items[0]);
    if (!target) return;
    void session.openReviewMode(items, target.ctx, target.serverId);
  }

  // ── Opt-in guide generation ──
  // Guides no longer generate automatically; this queues them in the background
  // for the checked PRs so they're ready by the time each review opens.
  const guideEligible = $derived(
    selected.filter((pr) => pr.state === "open" && !pr.draft),
  );
  const guidesInFlight = $derived(
    [...pullRequests.guides.status.values()].filter(
      (status) => status === "queued" || status === "generating",
    ).length,
  );

  function generateGuides() {
    if (selectionSpansProjects) {
      toasts.error("Select pull requests from one project to generate guides");
      return;
    }
    const numbers = guideEligible.map((pr) => pr.number);
    if (numbers.length === 0) return;
    const target = targetFor(guideEligible[0]);
    if (!target) return;
    const projectPath = target.ctx.session.projectPath ?? null;
    toasts.info(
      numbers.length === 1
        ? `Started generating the review guide for PR #${numbers[0]}`
        : `Started generating ${numbers.length} review guides`,
    );
    void pullRequests.guides
      .request(target.api, target.serverId, target.ctx, numbers, {
        onSettled: ({ total, failed }) => {
          const toastOptions = {
            action: {
              label: "View",
              onAction: () => session.openPrs(projectPath),
            },
          };
          if (failed > 0) {
            toasts.error(
              failed === total
                ? `Couldn't generate ${total === 1 ? "the review guide" : `${total} review guides`}`
                : `${total - failed} of ${total} review guides ready; ${failed} failed`,
              toastOptions,
            );
            return;
          }
          toasts.success(
            total === 1
              ? `Review guide for PR #${numbers[0]} is ready.`
              : `${total} review guides are ready. Open a pull request to start reviewing.`,
            toastOptions,
          );
        },
      })
      .catch((error) => {
        toasts.error("Couldn't queue review guides", {
          description: error instanceof Error ? error.message : String(error),
        });
      });
  }

  function refreshList() {
    if (isInboxView) {
      void store.listAll(inboxProjects, { state: fetchScope }, { force: true });
      return;
    }
    void shownScope()?.list({ filter: { state: fetchScope }, force: true });
  }

  // Narrowing within what is already loaded is free; widening past it is a
  // fetch. Only reload when the scope actually moves, so toggling Draft off and
  // on doesn't re-hit the host.
  function onStatusChange(next: string[]) {
    const scope = prFetchScope(next);
    const refetch = scope !== fetchScope;
    listView.statusKeys = next;
    if (!refetch) return;
    if (isInboxView) {
      void store.listAll(inboxProjects, { state: scope });
      return;
    }
    void shownScope()?.list({ filter: { state: scope } });
  }

  // ── Keybindings ──
  // While the panel is open, Esc belongs to it: it collapses full screen, then
  // closes the review, and only an empty list page closes the page itself.
  useScope("prs", { active: () => open });
  useKeybinding("prs.close", () => close(), {
    enabled: () => open && !panelOpen,
  });
  function close() {
    session.router.close("prs");
    requestInputFocus();
  }

  // ── List keyboard nav ──
  function onListKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const idx = selectedKey
        ? listNavigationItems.findIndex((p) => keyOf(p) === selectedKey)
        : -1;
      const next =
        e.key === "ArrowDown"
          ? Math.min(idx + 1, listNavigationItems.length - 1)
          : Math.max(idx - 1, 0);
      if (listNavigationItems[next]) highlightPr(listNavigationItems[next]);
    } else if (e.key === "Enter" && selectedPr) {
      e.preventDefault();
      selectPr(selectedPr);
    } else if ((e.key === "x" || e.key === "X") && selectedPr) {
      // x checks the highlighted PR for review — keyboard-first multi-select,
      // matching the tasks list.
      e.preventDefault();
      toggleReviewSelect(selectedPr);
    }
  }

  // Viewport-rooted so clipping ancestors still apply inside the page's scroll
  // region.
  function observeEffort(node: HTMLElement, pr: PullRequest | undefined) {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          const target = pr ? targetFor(pr) : null;
          if (pr && target) {
            void store.at(target.serverId, projectScopeOf(target.ctx.session))?.loadEfforts([pr.number]);
          }
          observer.disconnect();
        }
      },
      { rootMargin: "240px 0px" },
    );
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }

  // Auto-load the next page as the list tail approaches. A sentinel rather than
  // an onscroll handler, so it is independent of which element is scrolling.
  function loadMoreSentinel(node: HTMLElement) {
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        for (const scope of paginating) {
          if (scope.hasMore && !scope.loading) {
            void scope.list({ page: scope.nextPage });
          }
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }
</script>

{#snippet reviewActions()}
  {#if selected.length > 0}
    <div
      class="flex items-center gap-1.5"
      transition:fly={{ y: -4, duration: 160 }}
    >
      <span
        class=" text-xs tabular-nums whitespace-nowrap text-muted-foreground"
      >
        {selected.length} selected
      </span>
      <Button
        type="button"
        class="inline-flex h-[26px] shrink-0 cursor-pointer items-center rounded-lg border-0 bg-transparent px-2 text-workspace-chrome font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        onclick={clearReviewSelection}
        aria-label={`Clear ${selected.length} selected pull requests`}
      >
        Clear
      </Button>
      <Button
        type="button"
        class="inline-flex h-[26px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-muted px-2.5 text-workspace-chrome font-medium text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        disabled={guideEligible.length === 0}
        onclick={generateGuides}
        aria-label={`Generate ${guideEligible.length} review guides in the background`}
      >
        {#if guidesInFlight > 0}
          <CircleNotchIcon
            size={12}
            class="shrink-0 animate-spin [animation-duration:0.9s]"
          />
        {:else}
          <BookOpenTextIcon size={12} class="shrink-0" />
        {/if}
        <span>Guides</span>
      </Button>
      <Button
        type="button"
        onclick={openReviewMode}
        class="inline-flex h-[26px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-primary px-2.5 text-workspace-chrome font-medium text-primary-foreground transition-[filter] duration-100 hover:brightness-[1.07]"
      >
        <PlayIcon size={12} weight="fill" class="shrink-0" />
        <span>Review</span>
      </Button>
    </div>
  {/if}
{/snippet}

{#snippet filterBar()}
  <!-- One row in every shape the list takes. The inbox orders itself, so it
       has no Sort. Refresh joins the row only while the crumb line that carries
       it is gone. -->
  <PrListToolbar
    bind:query={listView.query}
    bind:searchEl
    placeholder={isInboxView
      ? "Search your inbox…"
      : "Search pull requests, branches, authors…"}
    bind:sortMode={listView.sortMode}
    sortOptions={isInboxView ? undefined : SORT_OPTIONS}
    {filterGroups}
    onRefresh={splitList ? refreshList : undefined}
    refreshing={activeRefreshing}
  />
{/snippet}

{#snippet pageActions()}
  {@render reviewActions()}
{/snippet}

{#if open}
  <!-- This page owns its titlebar chrome (see the `prs` route), so it paints to
       the window's top edge. The list uses the same fixed top measure as the
       Automations workspace; its position does not change with the sidebar. -->
  <div
    class="@container relative flex min-h-0 flex-1 overflow-hidden bg-card focus:outline-none [--pr-list-width:380px]"
    bind:clientWidth={pageWidth}
    role="dialog"
    aria-label="Pull Requests"
    tabindex="-1"
  >
    {#if showPageSkeleton}
      <!-- This is the PR route's only loading state. The page root remains
           mounted so its width is known when a remembered detail panel returns
           after the read. -->
      <PrsPageSkeleton />
    {:else}
    <!-- A pull request comes out from the side of this list rather than
         replacing it. The list narrows to a navigation column and the review
         takes the room that is left, so the queue stays readable while one item
         is open; E gives the review the whole surface, and Esc walks that back
         one step at a time. -->
    <!-- The list resizes in one layout pass, in both directions. It can, because
         the panel beside it never shares this flow: it is positioned over the
         room this width leaves (see below), so neither opening nor closing makes
         the queue relayout frame by frame while the panel moves. -->
    <div
      class="flex min-h-0 min-w-0 shrink-0 {splitList
        ? 'w-(--pr-list-width)'
        : 'w-full'}"
    >
    <!-- The switcher scopes the project list. The inbox is cross-project, so it
         reads "All projects" there rather than losing the crumb: a first crumb
         that vanished would strand the reader with no path back up. -->
    <ListPage
      split={splitList}
      projects={projectOptions}
      activeProjectKey={isInboxView ? "" : activeProjectOptionKey}
      emptyProjectLabel={isInboxView ? "All projects" : "No project"}
      onSelectProject={selectProject}
      onRemoveProjectHistory={removeProjectHistory}
      page="prs"
      title={splitList ? "Pull Requests" : isInboxView ? "Inbox" : undefined}
      {view}
      onViewChange={splitList ? undefined : setView}
      globalLabel="Project"
      inboxLabel="Inbox"
      compactViewSwitcherText
      {unreadCount}
      onRefresh={splitList ? undefined : refreshList}
      refreshing={activeRefreshing}
      syncedAt={synced.at}
      onMoveAcross={pane.inPane ? pane.moveAcross : undefined}
      isLeading={pane.isLeading}
      onClose={close}
      actions={splitList ? undefined : pageActions}
      filters={filterBar}
      toolbarFilters
      contentOwnsScroll
      hideHeader={panelOpen}
      pageSwitcherEnabled={!splitList}
      bind:contentHeight
    >
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div bind:this={listEl} onkeydown={onListKeydown} role="presentation">
        {#if inboxFailure.placement === "banner"}
          <!-- Partial failure: the rows that did load stay, and this line
               carries the part that didn't. -->
          <div class="px-3 pt-3">
            <div
              class="flex items-center gap-2.5 rounded-2xl border border-border bg-card px-3.5 py-3 text-workspace-chrome"
              role="alert"
            >
              {#if inboxFailure.kind === "github-auth"}
                <GithubConnectionRequired serverId={inboxFailure.serverId} />
              {:else}
                <span class="min-w-0 flex-1 truncate"
                  >{inboxFailure.summary}</span
                >
                <Button
                  type="button"
                  variant="ghost"
                  class="inline-flex h-[30px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-muted px-3 text-workspace-chrome font-medium text-muted-foreground transition-colors hover:text-foreground"
                  onclick={refreshList}
                >
                  <ArrowsClockwiseIcon size={12} class="shrink-0" />
                  Retry
                </Button>
              {/if}
            </div>
          </div>
        {/if}
        {#if !isInboxView && !scopedProjectPath}
          <PageEmpty
            icon={GitPullRequestIcon}
            title="Open a project to see its pull requests."
          >
            The project in the input bar sets this list.
          </PageEmpty>
        {:else if !isInboxView && shown?.error?.kind === "github-auth"}
          <PageEmpty
            icon={GithubLogoIcon}
            tone="muted"
            title="Connect GitHub to load pull requests."
          >
            {#if prsServerId}
              <GithubConnectionRequired serverId={prsServerId} layout="stacked" />
            {/if}
          </PageEmpty>
        {:else if inboxFailure.kind === "github-auth" && inboxFailure.placement === "page"}
          <PageEmpty
            icon={GithubLogoIcon}
            tone="muted"
            title="Connect GitHub to load pull requests."
          >
            <GithubConnectionRequired
              serverId={inboxFailure.serverId}
              layout="stacked"
            />
          </PageEmpty>
        {:else if !isInboxView && shown?.error?.kind === "no-repository"}
          <!-- A folder with no remote — My Workspace, a plain directory. It has
               no pull requests, which is a state to state, not a failure. -->
          <PageEmpty
            icon={GitPullRequestIcon}
            tone="muted"
            title="This project has no git remote."
          >
            Pull requests show up once this folder points at a repository on
            GitHub.
          </PageEmpty>
        {:else if !isInboxView && shown?.error}
          <PageEmpty
            icon={WarningCircleIcon}
            tone="muted"
            title="Couldn’t load pull requests."
          >
            {shown?.error?.message}
            {#snippet actions()}
              <Button type="button" variant="outline" onclick={refreshList}>
                <ArrowsClockwiseIcon size={14} />
                Retry
              </Button>
            {/snippet}
          </PageEmpty>
        {:else if inboxFailure.kind === "generic" && inboxFailure.placement === "page"}
          <PageEmpty
            icon={WarningCircleIcon}
            tone="muted"
            title="Couldn’t load pull requests."
          >
            {inboxFailure.detail}
            {#snippet actions()}
              <Button type="button" variant="outline" onclick={refreshList}>
                <ArrowsClockwiseIcon size={14} />
                Retry
              </Button>
            {/snippet}
          </PageEmpty>
        {:else if activeItems.length === 0}
          <PageEmpty icon={GitPullRequestIcon} title="No pull requests yet.">
            {isInboxView
              ? "Open pull requests from any of your projects' remotes will show up here."
              : "Open pull requests from this project's remote will show up here."}
            {#snippet actions()}
              <Button
                type="button"
                class="inline-flex h-[34px] cursor-pointer items-center gap-2 rounded-lg border-0 bg-muted px-3 text-workspace-chrome font-medium text-muted-foreground transition-colors hover:text-foreground"
                onclick={refreshList}
              >
                <ArrowsClockwiseIcon size={13} class="shrink-0" />
                Refresh
              </Button>
            {/snippet}
          </PageEmpty>
        {:else if view === "inbox"}
          {#if inboxGroups.length === 0}
            <ListEmpty title="Inbox zero."
              >No pull request is waiting on you.</ListEmpty
            >
          {:else}
            <VirtualList
              items={inboxVirtualItems}
              height={contentHeight}
              itemSize={(index) =>
                inboxVirtualItems[index].kind === "header"
                  ? LIST_GROUP_HEADER_HEIGHT
                  : inboxRowHeight(recordRows)}
              keyOf={(item) => item.key}
              activeKey={inboxActiveKey}
              scrollOffset={listView.scrollTop}
              onAfterScroll={({ offset }) => (listView.scrollTop = offset)}
            >
              {#snippet children(item, _index, style)}
                <div {style}>
                  {#if item.kind === "header"}
                    <ListGroup
                      label={item.group.label}
                      count={item.group.rows.length}
                      open={!listView.collapsedGroups[`inbox:${item.group.key}`]}
                      onToggle={() => {
                        const groupKey = `inbox:${item.group.key}`;
                        listView.collapsedGroups[groupKey] =
                          !listView.collapsedGroups[groupKey];
                      }}
                      note={item.group.note}
                      accent={item.group.accent}
                    >
                      {#snippet children()}{/snippet}
                    </ListGroup>
                  {:else}
                  <InboxRow
                    row={item.row}
                    hot={!!item.group.accent}
                    responsiveTitle
                    selected={selectedKey === item.row.key}
                    onSelect={() => {
                      const pr = prByKey(item.row.key);
                      if (pr)
                        selectPr(
                          pr,
                          item.row.primary?.label === "Review"
                            ? "diff"
                            : undefined,
                        );
                    }}
                    onContextMenu={(event) => {
                      const pr = prByKey(item.row.key);
                      if (pr) openPrContextMenu(event, pr);
                    }}
                  />
                  {/if}
                </div>
              {/snippet}
            </VirtualList>
          {/if}
        {:else if groups.length === 0}
          <ListEmpty title="Nothing matches">
            Clear the filters or widen the search.
            {#snippet actions()}
              <Button
                type="button"
                class="inline-flex h-8 cursor-pointer items-center rounded-lg border-0 bg-muted px-3 text-workspace-chrome font-medium text-muted-foreground transition-colors hover:text-foreground"
                onclick={() => {
                  listView.query = "";
                  listView.involvement = "all";
                  listView.author = null;
                  listView.label = null;
                  listView.draft = "all";
                  listView.review = "all";
                  listView.checks = "all";
                  onStatusChange([...OPEN_PR_STATUS_KEYS]);
                }}
              >
                Clear filters
              </Button>
            {/snippet}
          </ListEmpty>
        {:else}
          <VirtualList
            items={globalVirtualItems}
            height={contentHeight}
            itemSize={(index) =>
              globalVirtualItems[index].kind === "header"
                ? LIST_GROUP_HEADER_HEIGHT
                : splitList
                  ? listRowHeight({ record: recordRows, split: true })
                  : PR_LIST_ROW_HEIGHT}
            keyOf={(item) => item.key}
            activeKey={globalActiveKey}
            scrollOffset={listView.scrollTop}
            onAfterScroll={({ offset }) => (listView.scrollTop = offset)}
          >
            {#snippet children(item, _index, style)}
              <div {style}>
                {#if item.kind === "header"}
                  <ListGroup
                    label={item.group.label}
                    count={item.group.rows.length}
                    open={!listView.collapsedGroups[item.group.key]}
                    onToggle={() =>
                      (listView.collapsedGroups = {
                        ...listView.collapsedGroups,
                        [item.group.key]:
                          !listView.collapsedGroups[item.group.key],
                      })}
                  >
                    {#snippet children()}{/snippet}
                  </ListGroup>
                {:else}
                {@const pr = prByKey(item.row.key)}
                {@const rowSelected =
                  selectedKey === item.row.key ||
                  reviewSelection.has(item.row.key)}
                {#snippet reviewCheckbox()}
                  <button
                    type="button"
                    class="mr-2 grid size-4 shrink-0 cursor-pointer place-items-center rounded border-0 text-xs transition-opacity {reviewSelection.has(
                      item.row.key,
                    )
                      ? 'bg-primary text-primary-foreground opacity-100'
                      : 'bg-[var(--wash-3)] text-transparent opacity-0 group-hover:opacity-100'}"
                    onclick={() => {
                      if (pr) toggleReviewSelect(pr);
                    }}
                    aria-pressed={reviewSelection.has(item.row.key)}
                    aria-label="Select for review"
                  >
                    ✓
                  </button>
                {/snippet}
                <div use:observeEffort={pr}>
                  {#if splitList}
                    <ListRailRow
                      row={item.row}
                      responsiveTitle
                      selected={rowSelected}
                      leading={reviewCheckbox}
                      onSelect={() => {
                        if (pr) selectPr(pr);
                      }}
                      onContextMenu={(event) => {
                        if (pr) openPrContextMenu(event, pr);
                      }}
                    />
                  {:else}
                    <PrListRow
                      row={item.row}
                      selected={rowSelected}
                      leading={reviewCheckbox}
                      onSelect={() => {
                        if (pr) selectPr(pr);
                      }}
                      onContextMenu={(event) => {
                        if (pr) openPrContextMenu(event, pr);
                      }}
                    />
                  {/if}
                </div>
                {/if}
              </div>
            {/snippet}
            {#snippet footer()}
              {#if isInboxView ? (inboxHasMore || inboxLoadingMore) : (shown?.hasMore || shown?.loadingMore)}
                <div use:loadMoreSentinel class="flex items-center justify-center py-3">
                  <Button
                    type="button"
                    class="inline-flex h-8 cursor-pointer items-center rounded-lg border-0 bg-muted px-3 text-workspace-chrome font-medium text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={isInboxView ? inboxLoadingMore : (shown?.loadingMore ?? false)}
                    onclick={() => {
                      for (const scope of paginating) {
                        if (scope.hasMore) void scope.list({ page: scope.nextPage });
                      }
                    }}
                  >
                    {(isInboxView ? inboxLoadingMore : (shown?.loadingMore ?? false)) ? "Loading…" : "Load more pull requests"}
                  </Button>
                </div>
              {/if}
            {/snippet}
          </VirtualList>
        {/if}
      </div>
    </ListPage>
    </div>

    <!-- A one-item each block keeps its item value while the fly outro runs.
         An if block would keep evaluating openTarget after closePanel clears the
         open key, so the mounted child could read .ctx from null mid-outro. -->
    {#each openPanel ? [openPanel] : [] as panel}
      <!-- Out of the list's flow on purpose, not just when full screen: it
           covers the room the list's width leaves rather than claiming its own.
           In flow, this panel's arrival and departure were layout events — the
           list had to travel with it, animating a width that can never reach the
           compositor, in the same frames PrDetailPanel mounts in. Over the top,
           the fly is transform and opacity alone and nothing relayouts, so both
           directions cost one layout pass. -->
      <div
        class="flex flex-col bg-background {panelFullScreen
          ? 'absolute inset-0 z-20'
          : 'absolute inset-y-0 right-0 left-(--pr-list-width) z-10 min-w-0 shadow-[-1px_0_0_var(--hairline-strong),-18px_0_30px_-26px_rgba(0,0,0,.28)]'}"
        transition:fly={{ x: 14, duration: reduceMotion ? 0 : 200 }}
      >
        <PrDetailPanel
          number={panel.pr.number}
          api={panel.target.api}
          serverId={panel.target.serverId}
          ctx={panel.target.ctx}
          title={panel.pr.title}
          baseRepo={panel.pr.baseRepo}
          fullScreen={panelFullScreen}
          onToggleFullScreen={roomForSplit ? toggleFullScreen : undefined}
          onClose={closePanel}
          onStep={stepPanel}
        />
      </div>
    {/each}

    {#if prContextMenu}
      {@const menuPr = prContextMenu.pr}
      <PrContextMenu
        x={prContextMenu.x}
        y={prContextMenu.y}
        pr={menuPr}
        onOpen={() => selectPr(menuPr)}
        onReview={() => selectPr(menuPr, "diff")}
        onOpenWeb={() => openPrExternal(menuPr)}
        onClose={() => (prContextMenu = null)}
      />
    {/if}
    {/if}
  </div>
{/if}
