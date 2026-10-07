<script lang="ts">
  import { untrack } from "svelte";
  import {
    createColumnHelper,
    createTable,
    functionalUpdate,
    type SortingState,
  } from "@tanstack/svelte-table";
  import {
    ChevronDown as CaretDownIcon,
    ChevronRight as CaretRightIcon,
    ListFilter as ListFilterIcon,
    Layers2 as StackSimpleIcon,
    MessageSquare as SessionIcon,
    CircleDashed as RunningIcon,
    CloudDownload as FetchIcon,
  } from "@lucide/svelte";
  import * as Table from "../ui/table";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import DataTableEmptyState from "./data-table/DataTableEmptyState.svelte";
  import DataTableColumnsMenu from "./data-table/DataTableColumnsMenu.svelte";
  import DataTableContextMenu from "./data-table/DataTableContextMenu.svelte";
  import DataTablePagination from "./data-table/DataTablePagination.svelte";
  import DataTableResizeHandle from "./data-table/DataTableResizeHandle.svelte";
  import DataTableSortIcon from "./data-table/DataTableSortIcon.svelte";
  import DataTableToolbar from "./data-table/DataTableToolbar.svelte";
  import {
    isColumnResized,
    nudgeColumnSize,
    resetColumnSize,
    seedColumnSize,
  } from "./data-table/column-sizing";
  import {
    cellContextFrom,
    hasTextSelection,
    type CellContext,
  } from "./data-table/table-pointer";
  import {
    insightsTableFeatures,
    type InsightsTableFeatures,
  } from "./data-table/data-table-features";
  import {
    formatClock,
    formatCost,
    formatDayClock,
    formatDuration,
    formatTokens,
    singleLine,
    spansMultipleDays,
  } from "./lib/format";
  import { MIN_TRACK_PX } from "./lib/table-grid";
  import { modelName, providerMark } from "./lib/provider";
  import ProviderMark from "../ui/ProviderMark.svelte";
  import { turnHostValue, type TurnHostChoice } from "./lib/turn-hosts";
  import type { TurnUserChoice } from "./lib/turn-users";
  import { TURN_STATUS_CHOICES, statusFilterFor } from "./lib/rail-filters";
  import type { TurnFlag } from "@solus/contracts/observability-types";
  import { flagChoice, flagColor, flagTitle } from "./lib/turn-flags";
  import {
    countByStatus,
    groupBySession,
    isRunningTurn,
    p95Duration,
    sessionCellLabel,
    withStatus,
    type TurnRow,
    type TurnSort,
    type TurnSortKey,
    type TurnStatusFilter,
    type TurnStatusCounts,
  } from "./lib/turn-rows";

  interface Props {
    rows: TurnRow[];
    sort: TurnSort;
    onSortChange: (sort: TurnSort) => void;
    statusFilter: TurnStatusFilter | null;
    onStatusFilterChange: (status: TurnStatusFilter | null) => void;
    grouped: boolean;
    onGroupedChange: (grouped: boolean) => void;
    selectedTraceId: string | null;
    onOpenTurn: (row: TurnRow) => void;
    /** Opens a turn's conversation; absent where conversations cannot be opened. */
    onOpenSession?: (sessionId: string) => void;
    /** The session's own Insights page — every turn of it on one axis. */
    onOpenSessionPage?: (sessionId: string) => void;
    /** The session's own name, when the host has one, for a turn with no task. */
    sessionName?: (sessionId: string) => string | null;
    /** A person's marks on turns, by trace, for the chip beside the prompt. */
    flags?: ReadonlyMap<string, TurnFlag>;
    emptyHint: string;
    totalRows?: number;
    pageIndex?: number;
    pageSize?: number;
    onPageChange?: (pageIndex: number) => void;
    onPageSizeChange?: (pageSize: number) => void;
    /** A page or sort change is reading new rows. The rows on screen stay,
     *  dimmed, until the new ones land. */
    rowsLoading?: boolean;
    fullStatusCounts?: TurnStatusCounts;
    fullP95DurationMs?: number | null;
    search?: string;
    onSearchChange?: (search: string) => void;
    /** What the Host column names a turn's host by. */
    hostLabel: (row: TurnRow) => string;
    /** Adds a User column: who ran each turn, for a listing of many people's turns. */
    showUser?: boolean;
    /** The Host filter's choices; the menu shows only when turns ran on more than one host. */
    hostChoices?: TurnHostChoice[];
    hostFilter?: string | null;
    onHostFilterChange?: (hostId: string | null | undefined) => void;
    /** The User filter's choices, for a listing of many people's turns. */
    userChoices?: TurnUserChoice[];
    /** The chosen user's id; absent for everyone. */
    userFilter?: string | null;
    onUserFilterChange?: (userId: string | undefined) => void;
    /** The host is pulling turns other hosts ran: rows may still arrive. */
    pulling?: boolean;
    /** Why the last pull of other hosts' turns failed. */
    pullError?: string | null;
  }

  let {
    rows,
    sort,
    onSortChange,
    statusFilter,
    onStatusFilterChange,
    grouped,
    onGroupedChange,
    selectedTraceId,
    onOpenTurn,
    onOpenSession,
    onOpenSessionPage,
    sessionName,
    flags,
    emptyHint,
    totalRows,
    pageIndex,
    pageSize,
    onPageChange,
    onPageSizeChange,
    rowsLoading = false,
    fullStatusCounts,
    fullP95DurationMs,
    search,
    onSearchChange,
    hostLabel,
    showUser = false,
    hostChoices = [],
    hostFilter,
    onHostFilterChange,
    userChoices = [],
    userFilter,
    onUserFilterChange,
    pulling = false,
    pullError = null,
  }: Props = $props();

  const hostValue = $derived(turnHostValue(hostFilter));
  const activeHost = $derived(hostChoices.find((choice) => choice.value === hostValue));
  const activeUser = $derived(userChoices.find((choice) => choice.id === userFilter));

  const serverPaged = $derived(totalRows !== undefined);

  let collapsed = $state<Record<string, boolean>>({});
  /** A session's turns are a bounded window, so a turn opened from anywhere but
   *  a click on its own row — a deep link, the panel's turn stepper — can sit
   *  below it. The list brings the open row back into view. */
  let listElement = $state<HTMLElement | null>(null);
  $effect(() => {
    const traceId = selectedTraceId;
    if (!listElement || !traceId) return;
    listElement
      .querySelector<HTMLElement>(`[data-trace-row="${CSS.escape(traceId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  });
  let rowMenu = $state<{
    x: number;
    y: number;
    cell: CellContext;
    row: TurnRow;
  } | null>(null);
  const counts = $derived(fullStatusCounts ?? countByStatus(rows));
  const statusRows = $derived(withStatus(rows, statusFilter));
  const p95 = $derived(
    fullP95DurationMs !== undefined ? fullP95DurationMs : p95Duration(rows),
  );

  // The clock column names two different instants once a listing straddles a
  // day, so the rows say which day they are on.
  const spansDays = $derived(
    spansMultipleDays(rows.map((row) => row.startedAt)),
  );

  const activeStatus = $derived(
    TURN_STATUS_CHOICES.find((choice) => choice.value === statusFilter),
  );
  const HEADS: { key: TurnSortKey; label: string; align: "start" | "end" }[] = [
    { key: "startedAt", label: "Time", align: "start" },
    { key: "prompt", label: "Prompt", align: "start" },
    { key: "sessionId", label: "Session", align: "start" },
    { key: "model", label: "Model", align: "start" },
    { key: "host", label: "Host", align: "start" },
    { key: "user", label: "User", align: "start" },
    { key: "durationMs", label: "Duration", align: "end" },
    { key: "costUsd", label: "Cost", align: "end" },
    { key: "tokens", label: "Tokens", align: "end" },
  ];
  // Default widths, in pixels and including the cell's own padding, sized from
  // what each column holds: a wall-clock instant with its day, a task title or
  // a short session id, a model name, and measures no wider than their widest
  // value. They are only defaults — every column is resizable.
  const WIDTHS = {
    startedAt: 124,
    prompt: 360,
    sessionId: 184,
    model: 152,
    host: 140,
    user: 180,
    durationMs: 104,
    costUsd: 92,
    tokens: 96,
  } satisfies Record<TurnSortKey, number>;

  /** The leftover width goes to the prompt, which is the column worth reading
   *  in place. Left to the browser it pools between the ids and the measures,
   *  which is how a truncated prompt ends up beside four columns of blank.
   *
   *  `width:100%` claims the slack and `max-width:0` stops the prompt's own
   *  length from sizing the table instead — the two together are what make a
   *  cell truncate rather than scroll. Drag the prompt and it stops absorbing
   *  the slack: a width the reader set is theirs. */
  function trackStyle(key: TurnSortKey, sizePx: number): string {
    return key === "prompt" && !isColumnResized(dataTable, "prompt")
      ? `min-width:${sizePx}px;width:100%;max-width:0`
      : `width:${sizePx}px;min-width:${sizePx}px;max-width:${sizePx}px`;
  }

  const columnHelper = createColumnHelper<InsightsTableFeatures, TurnRow>();
  const columns = columnHelper.columns([
    columnHelper.accessor("startedAt", {
      id: "startedAt",
      header: "Time",
      sortDescFirst: true,
      size: WIDTHS.startedAt,
      minSize: MIN_TRACK_PX,
    }),
    columnHelper.accessor("prompt", {
      id: "prompt",
      header: "Prompt",
      sortDescFirst: true,
      size: WIDTHS.prompt,
      minSize: 200,
    }),
    columnHelper.accessor((row) => row.sessionId ?? undefined, {
      id: "sessionId",
      header: "Session",
      sortDescFirst: true,
      sortUndefined: "last",
      size: WIDTHS.sessionId,
      minSize: MIN_TRACK_PX,
    }),
    columnHelper.accessor((row) => row.model ?? undefined, {
      id: "model",
      header: "Model",
      sortDescFirst: true,
      sortUndefined: "last",
      size: WIDTHS.model,
      minSize: MIN_TRACK_PX,
    }),
    columnHelper.accessor((row) => row.hostname ?? undefined, {
      id: "host",
      header: "Host",
      sortDescFirst: false,
      sortUndefined: "last",
      size: WIDTHS.host,
      minSize: MIN_TRACK_PX,
    }),
    ...(untrack(() => showUser)
      ? [
          columnHelper.accessor((row) => row.userEmail ?? undefined, {
            id: "user",
            header: "User",
            sortDescFirst: false,
            sortUndefined: "last",
            size: WIDTHS.user,
            minSize: MIN_TRACK_PX,
          }),
        ]
      : []),
    columnHelper.accessor((row) => row.durationMs ?? undefined, {
      id: "durationMs",
      header: "Duration",
      sortDescFirst: true,
      sortUndefined: "last",
      size: WIDTHS.durationMs,
      minSize: MIN_TRACK_PX,
    }),
    columnHelper.accessor((row) => row.costUsd ?? undefined, {
      id: "costUsd",
      header: "Cost",
      sortDescFirst: true,
      sortUndefined: "last",
      size: WIDTHS.costUsd,
      minSize: MIN_TRACK_PX,
    }),
    columnHelper.accessor(
      (row) =>
        row.inputTokens == null && row.outputTokens == null
          ? undefined
          : (row.inputTokens ?? 0) + (row.outputTokens ?? 0),
      {
        id: "tokens",
        header: "Tokens",
        sortDescFirst: true,
        sortUndefined: "last",
        size: WIDTHS.tokens,
        minSize: MIN_TRACK_PX,
      },
    ),
  ]);

  const dataTable = createTable({
    features: insightsTableFeatures,
    get data() {
      return statusRows;
    },
    columns,
    get manualPagination() {
      return serverPaged;
    },
    get manualSorting() {
      return serverPaged;
    },
    get rowCount() {
      return totalRows;
    },
    state: {
      get sorting(): SortingState {
        return [{ id: sort.key, desc: sort.dir === "desc" }];
      },
    },
    // The listing is always sorted by something: the parent holds one sort key
    // and one direction, and there is no "unsorted" turn order to return to.
    // With removal enabled, the third state is an empty sorting array this
    // component cannot express, so a header stopped toggling after one click.
    enableSortingRemoval: false,
    onSortingChange: (updater) => {
      const next = functionalUpdate(updater, [
        { id: sort.key, desc: sort.dir === "desc" },
      ]);
      const first = next[0];
      const matchingHead = first
        ? HEADS.find((head) => head.key === first.id)
        : undefined;
      if (first && matchingHead) {
        onSortChange({
          key: matchingHead.key,
          dir: first.desc ? "desc" : "asc",
        });
      }
    },
    columnResizeMode: "onChange",
    initialState: {
      pagination: { pageIndex: 0, pageSize: untrack(() => serverPaged) ? 100 : 25 },
    },
  });

  const filteredSortedRows = $derived(
    dataTable.getSortedRowModel().rows.map((row) => row.original),
  );
  const pageRows = $derived(
    dataTable.getRowModel().rows.map((row) => row.original),
  );
  const groups = $derived(grouped ? groupBySession(filteredSortedRows) : []);

  function head(columnId: string): (typeof HEADS)[number] {
    return HEADS.find((candidate) => candidate.key === columnId) ?? HEADS[0];
  }

  /** A click that ends a drag-select is the reader finishing a selection, not
   *  asking for the turn. */
  function activate(row: TurnRow): void {
    if (hasTextSelection()) return;
    onOpenTurn(row);
  }

  function openRowMenu(event: MouseEvent, row: TurnRow): void {
    event.preventDefault();
    event.stopPropagation();
    rowMenu = {
      x: event.clientX,
      y: event.clientY,
      cell: cellContextFrom(event),
      row,
    };
  }

  function rowMenuActions(row: TurnRow): { label: string; run: () => void }[] {
    const actions = [{ label: "Open turn", run: () => onOpenTurn(row) }];
    const sessionId = row.sessionId;
    const openSession = onOpenSession;
    if (sessionId && openSession) {
      actions.push({
        label: "Open session",
        run: () => openSession(sessionId),
      });
      const openPage = onOpenSessionPage;
      if (openPage) {
        actions.push({ label: "Session page", run: () => openPage(sessionId) });
      }
    }
    return actions;
  }

  function hideMenuColumn(columnId: string | null): (() => void) | undefined {
    if (!columnId) return undefined;
    const column = dataTable.getColumn(columnId);
    if (!column?.getCanHide()) return undefined;
    return () => column.toggleVisibility(false);
  }

  /** Status only. The turn open in the panel is marked by an outline rather
   *  than a fill: a wash on a row whose neighbours are all hoverable reads as
   *  selection, and it competes with the two washes that carry real state. */
  function rowBackground(row: TurnRow): string {
    if (row.status === "error")
      return "color-mix(in oklch, var(--failure) 7%, transparent)";
    if (row.status === "interrupted")
      return "color-mix(in oklch, var(--warning) 8%, transparent)";
    if (isRunningTurn(row))
      return "color-mix(in oklch, var(--primary) 5%, transparent)";
    return "transparent";
  }

  function durationColor(row: TurnRow): string {
    if (row.status === "error") return "var(--failure)";
    if (p95 != null && row.durationMs != null && row.durationMs >= p95)
      return "var(--warning)";
    return "var(--foreground)";
  }
</script>

<!-- One menu, the rail's Status menu in this band's pill: the three outcomes
     and their counts, and a way back to every turn. -->
{#snippet statusFilters()}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="flex h-6.5 shrink-0 cursor-pointer items-center gap-2 rounded-full bg-background pr-2.5 pl-3 text-insights-chrome text-foreground outline-none shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_2px_10px_color-mix(in_oklch,var(--foreground)_7%,transparent)] transition-[background-color,scale] hover:bg-[var(--wash-1)] focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96] data-[state=open]:bg-[var(--wash-1)] pointer-coarse:h-10"
          aria-label={activeStatus ? `Filter by status: ${activeStatus.label}` : "Filter by status"}
        >
          <ListFilterIcon class="size-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
          <span class="hidden sm:inline">{activeStatus?.label ?? "All statuses"}</span>
          {#if activeStatus}
            <span class="tabular-nums text-muted-foreground">{counts[activeStatus.value]}</span>
          {/if}
          <CaretDownIcon class="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
        </button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-52">
      <DropdownMenu.RadioGroup
        value={statusFilter ?? "all"}
        onValueChange={(value) => onStatusFilterChange(statusFilterFor(value))}
      >
        <DropdownMenu.RadioItem value="all">All statuses</DropdownMenu.RadioItem>
        {#each TURN_STATUS_CHOICES as status (status.value)}
          <DropdownMenu.RadioItem value={status.value}>
            <span class="min-w-0 flex-1 truncate">{status.label}</span>
            <span class="text-muted-foreground tabular-nums">{counts[status.value]}</span>
          </DropdownMenu.RadioItem>
        {/each}
      </DropdownMenu.RadioGroup>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/snippet}

{#snippet hostMenu(change: (hostId: string | null | undefined) => void)}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="flex h-6.5 max-w-48 shrink-0 cursor-pointer items-center gap-2 rounded-full bg-background pr-2.5 pl-3 text-insights-chrome text-foreground outline-none shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_2px_10px_color-mix(in_oklch,var(--foreground)_7%,transparent)] transition-[background-color,scale] hover:bg-[var(--wash-1)] focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96] data-[state=open]:bg-[var(--wash-1)] pointer-coarse:h-10"
          aria-label="Filter by host"
        >
          <span class="truncate">{activeHost?.label ?? "All hosts"}</span>
          <CaretDownIcon class="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
        </button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-56">
      <DropdownMenu.RadioGroup
        value={hostValue}
        onValueChange={(value) => change(hostChoices.find((choice) => choice.value === value)?.hostId)}
      >
        {#each hostChoices as choice (choice.value)}
          <DropdownMenu.RadioItem value={choice.value}>
            <span class="min-w-0 flex-1 truncate">{choice.label}</span>
            {#if choice.count !== null}<span class="text-muted-foreground tabular-nums">{choice.count}</span>{/if}
          </DropdownMenu.RadioItem>
        {/each}
      </DropdownMenu.RadioGroup>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/snippet}

{#snippet userMenu(change: (userId: string | undefined) => void)}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="flex h-6.5 max-w-48 shrink-0 cursor-pointer items-center gap-2 rounded-full bg-background pr-2.5 pl-3 text-insights-chrome text-foreground outline-none shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_2px_10px_color-mix(in_oklch,var(--foreground)_7%,transparent)] transition-[background-color,scale] hover:bg-[var(--wash-1)] focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96] data-[state=open]:bg-[var(--wash-1)] pointer-coarse:h-10"
          aria-label="Filter by user"
        >
          <span class="truncate">{activeUser?.label ?? "All users"}</span>
          <CaretDownIcon class="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
        </button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-64">
      <DropdownMenu.RadioGroup value={userFilter ?? ""} onValueChange={(value) => change(value || undefined)}>
        <DropdownMenu.RadioItem value="">All users</DropdownMenu.RadioItem>
        {#each userChoices as choice (choice.id)}
          <DropdownMenu.RadioItem value={choice.id}>
            <span class="min-w-0 flex-1 truncate">{choice.label}</span>
            <span class="text-muted-foreground tabular-nums">{choice.count}</span>
          </DropdownMenu.RadioItem>
        {/each}
      </DropdownMenu.RadioGroup>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/snippet}

{#snippet groupToggle()}
  <button
    type="button"
    class="flex h-6.5 shrink-0 cursor-pointer items-center gap-2 rounded-full px-3 text-insights-chrome text-foreground outline-none shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_2px_10px_color-mix(in_oklch,var(--foreground)_7%,transparent)] transition-[background-color,scale] focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96] pointer-coarse:h-10 {grouped
      ? 'bg-[var(--wash-3)]'
      : 'bg-background hover:bg-[var(--wash-1)]'}"
    aria-pressed={grouped}
    onclick={() => onGroupedChange(!grouped)}
  >
    <StackSimpleIcon class="size-4" strokeWidth={1.5} aria-hidden="true" />
    <span class="hidden sm:inline">Group by session</span>
  </button>
{/snippet}

{#snippet turnCell(row: TurnRow, columnId: string, indent: number)}
  {#if columnId === "startedAt"}
    <span
      class="block truncate text-insights-table tabular-nums text-muted-foreground"
      style="padding-left:{indent}px"
    >
      {spansDays ? formatDayClock(row.startedAt) : formatClock(row.startedAt)}
    </span>
  {:else if columnId === "prompt"}
    {@const flag = flags?.get(row.traceId)}
    <span class="flex min-w-0 items-center gap-2">
      <span class="truncate text-insights-table" title={row.prompt}
        >{singleLine(row.prompt) || "—"}</span
      >
      {#if flag}
        {@const choice = flagChoice(flag.kind)}
        <!-- The person's own mark, in the row: it is why the row is worth a
             second look, and the query surface later filters on it. -->
        <span
          class="flex shrink-0 items-center gap-1 text-insights-table"
          style="color:{flagColor(flag.kind)}"
          title={flagTitle(flag.kind, flag.note)}
        >
          <choice.icon class="size-3.5" aria-hidden="true" />
          {choice.short}
        </span>
      {/if}
    </span>
  {:else if columnId === "sessionId"}
    {#if grouped}
      <span></span>
    {:else}
      <!-- Text, not a link: the row is the target, and it opens the turn. A
           session cell that was itself a button caught every click that landed
           mid-row and opened the conversation instead. The way to the session
           is the small control at the cell's edge, shown on hover and always
           in the tab order, and the row's context menu. -->
      {@const label = sessionCellLabel(row, row.sessionId ? (sessionName?.(row.sessionId) ?? null) : null)}
      <span class="flex min-w-0 items-center gap-1">
        <span
          class="min-w-0 truncate text-insights-table text-muted-foreground {label.isId
            ? 'font-mono'
            : ''}"
          title={row.sessionId ?? undefined}
          >{label.text}</span
        >
        {#if row.sessionId && onOpenSession}
          {@const sessionId = row.sessionId}
          {@const openSession = onOpenSession}
          <button
            type="button"
            class="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-colors group-hover/turn:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--primary) pointer-coarse:opacity-100"
            title="Open the session"
            aria-label="Open the session"
            onclick={(event) => {
              event.stopPropagation();
              openSession(sessionId);
            }}><SessionIcon class="size-3" aria-hidden="true" /></button
          >
        {/if}
      </span>
    {/if}
  {:else if columnId === "model"}
    <!-- The model by its own name, behind its backend's logo. The recorded
         id — what a query filters on — is the hover. -->
    <span class="flex min-w-0 items-center gap-1.5" title={row.model ?? undefined}>
      <ProviderMark mark={providerMark(row.provider)} size={12} />
      <span class="truncate text-insights-table text-muted-foreground"
        >{modelName(row.provider, row.model) ?? "—"}</span
      >
    </span>
  {:else if columnId === "host"}
    <span class="block truncate text-insights-table text-muted-foreground" title={row.hostname ?? undefined}
      >{hostLabel(row)}</span
    >
  {:else if columnId === "user"}
    <span class="block truncate text-insights-table text-muted-foreground" title={row.userEmail ?? undefined}
      >{row.userEmail ?? "—"}</span
    >
  {:else if columnId === "durationMs"}
    {#if isRunningTurn(row)}
      <!-- A turn with no end is still running. The state is a shape, not a
           word, and the glyph is the rail's, so a running turn reads the same
           in both. It does not animate: the row changes when the turn ends. -->
      <span class="flex items-center justify-end text-(--primary)" role="img" aria-label="Running" title="Running">
        <RunningIcon class="size-3.5 shrink-0" aria-hidden="true" />
      </span>
    {:else}
      <span
        class="block text-right text-insights-table tabular-nums"
        style="color:{durationColor(row)}">{formatDuration(row.durationMs)}</span
      >
    {/if}
  {:else if columnId === "costUsd"}
    <span class="block text-right text-insights-table tabular-nums"
      >{formatCost(row.costUsd)}</span
    >
  {:else if columnId === "tokens"}
    <span class="block text-right text-insights-table tabular-nums"
      >{formatTokens(
        row.inputTokens == null && row.outputTokens == null
          ? null
          : (row.inputTokens ?? 0) + (row.outputTokens ?? 0),
      )}</span
    >
  {/if}
{/snippet}

<!-- One turn, listed flat or under its session. The turn open in the panel
     takes a hairline outline in place of its own row rule: it says "this is the
     one you are reading" without a fill that would read as selection, without
     weight the neighbouring prompts cannot answer, and without a dot or an edge
     rail. The error and interrupted washes stay: those are the row's state. -->
{#snippet turnRow(row: TurnRow, indent: number)}
  {@const current = row.traceId === selectedTraceId}
  <Table.Row
    class="group/turn h-10 cursor-pointer border-0 outline-none transition-[background-color,box-shadow] hover:bg-[color-mix(in_oklch,var(--foreground)_3.5%,transparent)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--primary) {current
      ? 'shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--solus-art-1)_55%,transparent)]'
      : 'shadow-[inset_0_-0.5px_0_var(--hairline)]'}"
    style="background:{rowBackground(row)}"
    data-trace-row={row.traceId}
    aria-current={current ? "true" : undefined}
    tabindex={0}
    onclick={() => activate(row)}
    oncontextmenu={(event) => openRowMenu(event, row)}
    onkeydown={(event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onOpenTurn(row);
      }
    }}
  >
    {#each dataTable.getVisibleLeafColumns() as column (column.id)}
      <Table.Cell
        class="overflow-hidden px-3 py-0"
        style={trackStyle(head(column.id).key, column.getSize())}
        data-column-id={column.id}
        data-column-label={head(column.id).label}
        >{@render turnCell(row, column.id, indent)}</Table.Cell
      >
    {/each}
  </Table.Row>
{/snippet}

<section
  class="flex min-h-35 flex-1 flex-col overflow-hidden"
  aria-label={grouped ? "Sessions" : "Turns"}
>
  <header
    class="relative flex min-h-13 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 shadow-[inset_0_-0.5px_0_var(--hairline-strong)]"
  >
    <div class="flex min-w-0 shrink-0 items-baseline gap-2">
      <h2 class="text-insights-chrome font-medium text-foreground">
        {grouped ? "Sessions" : "Turns"}
      </h2>
      <p class="truncate text-insights-chrome tabular-nums text-muted-foreground">
        {#if grouped}{groups.length} sessions on this page · {totalRows ?? filteredSortedRows.length} turns{:else}{totalRows ?? filteredSortedRows.length}{/if}
      </p>
    </div>

    {#if pulling}
      <div
        class="flex min-w-0 items-center gap-1.5 text-workspace-chrome text-muted-foreground"
        role="status"
      >
        <FetchIcon class="size-4 shrink-0" aria-hidden="true" />
        <span>Checking for synced turns…</span>
      </div>
    {/if}

    <DataTableToolbar
      table={dataTable}
      filterPlaceholder="Filter turns…"
      value={search}
      onValueChange={onSearchChange}
    />
    {@render groupToggle()}
    <span class="flex-1"></span>
    {#if pullError}
      <span class="shrink-0 text-insights-chrome text-muted-foreground" title={pullError}>Other hosts unavailable</span>
    {/if}
    {#if hostChoices.length > 2 && onHostFilterChange}
      {@render hostMenu(onHostFilterChange)}
    {/if}
    <!-- A chosen user stays offered when alone in the window, so the filter can be cleared. -->
    {#if onUserFilterChange && (userChoices.length > 1 || activeUser)}
      {@render userMenu(onUserFilterChange)}
    {/if}
    {@render statusFilters()}
    <DataTableColumnsMenu table={dataTable} />
  </header>

  <div class="min-h-0 flex-1 overflow-auto" data-sb bind:this={listElement}>
    <Table.Root
      containerClass="overflow-visible"
      class="min-w-full border-separate border-spacing-0"
    >
      <Table.Header
        class="sticky top-0 z-10 bg-background shadow-[0_1px_0_var(--hairline-strong),0_3px_8px_-6px_rgba(0,0,0,0.28)]"
      >
        {#each dataTable.getHeaderGroups() as headerGroup (headerGroup.id)}
          <Table.Row
            class="border-0 bg-[color-mix(in_oklch,var(--wash-1)_82%,var(--background))] hover:bg-[color-mix(in_oklch,var(--wash-1)_82%,var(--background))]"
          >
            {#each headerGroup.headers as header (header.id)}
              {@const definition = head(header.column.id)}
              {@const sorted = header.column.getIsSorted()}
              <Table.Head
                colspan={header.colSpan}
                class="group/head relative h-9 px-3 text-insights-table font-normal text-muted-foreground"
                style="{trackStyle(
                  definition.key,
                  header.getSize(),
                )};text-align:{definition.align === 'end' ? 'right' : 'left'}"
                aria-sort={sorted === "asc"
                  ? "ascending"
                  : sorted === "desc"
                    ? "descending"
                    : "none"}
              >
                <button
                  type="button"
                  class="group/sort flex h-9 w-full cursor-pointer items-center gap-1 outline-none transition-colors hover:text-foreground focus-visible:text-foreground {sorted
                    ? 'text-foreground'
                    : ''}"
                  class:flex-row-reverse={definition.align === "end"}
                  onclick={header.column.getToggleSortingHandler()}
                >
                  <span class="truncate"
                    >{grouped && definition.key === "sessionId"
                      ? ""
                      : definition.label}</span
                  >
                  <DataTableSortIcon direction={sorted} />
                </button>
                <DataTableResizeHandle
                  columnLabel={definition.label}
                  active={header.column.getIsResizing()}
                  onStart={(event, renderedWidthPx) => {
                    seedColumnSize(dataTable, definition.key, renderedWidthPx);
                    header.getResizeHandler()(event);
                  }}
                  onNudge={(delta) =>
                    nudgeColumnSize(dataTable, definition.key, delta)}
                  onReset={() => resetColumnSize(dataTable, definition.key)}
                />
              </Table.Head>
            {/each}
          </Table.Row>
        {/each}
      </Table.Header>
      <!-- The app disables selection at the root, so the rows opt back in: a
           reader must be able to drag a prompt or an id out of the table. -->
      <Table.Body
        class={["select-text motion-safe:transition-opacity", rowsLoading && "opacity-60"]}
        aria-busy={rowsLoading}
      >
        {#if grouped}
          {#each groups as group (group.sessionId)}
            {@const open = collapsed[group.sessionId] !== true}
            <Table.Row
              class="h-10 cursor-pointer bg-[color-mix(in_oklch,var(--wash-1)_74%,var(--background))] outline-none shadow-[inset_0_-0.5px_0_var(--hairline),inset_0_0.5px_0_var(--hairline)] transition-[background-color,box-shadow] hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--primary)"
              tabindex={0}
              aria-expanded={open}
              onclick={() => (collapsed[group.sessionId] = open)}
            >
              {#each dataTable.getVisibleLeafColumns() as column (column.id)}
                <Table.Cell
                  class="overflow-hidden px-3 py-0 text-insights-table"
                  style={trackStyle(head(column.id).key, column.getSize())}
                  data-column-id={column.id}
                  data-column-label={head(column.id).label}
                >
                  {#if column.id === "startedAt"}
                    <span class="flex items-center gap-1.5 tabular-nums">
                      <CaretRightIcon
                        class="size-2.5 opacity-70 transition-transform duration-150 motion-reduce:transition-none"
                        weight="bold"
                        style="transform:rotate({open ? 90 : 0}deg)"
                      />
                      {group.turns.length}
                      {group.turns.length === 1 ? "turn" : "turns"}
                    </span>
                  {:else if column.id === "prompt"}
                    <span class="block truncate text-insights-table font-medium"
                      >{singleLine(group.firstPrompt)}</span
                    >
                  {:else if column.id === "sessionId"}
                    <span class="block truncate" title={group.sessionId}
                      >{sessionCellLabel(group, sessionName?.(group.sessionId) ?? null).text}</span
                    >
                  {:else if column.id === "durationMs"}
                    <span class="block text-right tabular-nums"
                      >{formatDuration(group.totalDurationMs)}</span
                    >
                  {:else if column.id === "costUsd"}
                    <span class="block text-right tabular-nums"
                      >{formatCost(group.totalCostUsd)}</span
                    >
                  {/if}
                </Table.Cell>
              {/each}
            </Table.Row>
            {#if open}
              <!-- An expanded session is bounded so it stays an entry in a list
                   of sessions: three turns, five on a taller display, then
                   the session scrolls in place under the
                   app's standard thumb. Without it one long session pushes
                   every other session off the screen.

                   The turns are their own table inside one full-width cell,
                   which is what lets them scroll at all — table rows cannot.
                   The columns still line up because the inner table reserves a
                   stable gutter and is drawn that much wider, so the thumb sits
                   over the last cell's padding instead of narrowing the
                   prompt. -->
              <Table.Row class="border-0 hover:bg-transparent">
                <Table.Cell
                  colspan={Math.max(1, dataTable.getVisibleLeafColumns().length)}
                  class="p-0"
                >
                  <Table.Root
                    containerClass="scrollbar-on-hover max-h-30 overflow-x-hidden overflow-y-auto overscroll-contain [scrollbar-gutter:stable] [@media(min-height:1000px)]:max-h-50"
                    class="w-[calc(100%+0.5rem)] border-separate border-spacing-0"
                  >
                    <Table.Body class="select-text">
                      {#each group.turns as row (row.traceId)}
                        {@render turnRow(row, 14)}
                      {/each}
                    </Table.Body>
                  </Table.Root>
                </Table.Cell>
              </Table.Row>
            {/if}
          {/each}
        {:else}
          {#each pageRows as row (row.traceId)}
            {@render turnRow(row, 0)}
          {/each}
        {/if}

        {#if filteredSortedRows.length === 0}
          <Table.Row class="border-0 hover:bg-transparent">
            <Table.Cell
              colspan={Math.max(1, dataTable.getVisibleLeafColumns().length)}
              class="p-0"
            >
              <DataTableEmptyState
                filtered={statusRows.length > 0}
                title={statusRows.length === 0
                  ? "No turns in this result"
                  : "No matching turns"}
                description={statusRows.length === 0
                  ? emptyHint
                  : "Change or clear the table filter to see more turns."}
              />
            </Table.Cell>
          </Table.Row>
        {/if}
      </Table.Body>
    </Table.Root>
  </div>
  {#if !grouped || serverPaged}
    <DataTablePagination
      table={dataTable}
      {totalRows}
      {pageIndex}
      {pageSize}
      {onPageChange}
      {onPageSizeChange}
    />
  {/if}

  {#if rowMenu}
    {@const menu = rowMenu}
    <DataTableContextMenu
      x={menu.x}
      y={menu.y}
      cell={menu.cell}
      insightsId={menu.row.traceId}
      actions={rowMenuActions(menu.row)}
      onHideColumn={hideMenuColumn(menu.cell.columnId)}
      onResetWidths={() => dataTable.resetColumnSizing()}
      onClose={() => (rowMenu = null)}
    />
  {/if}
</section>
