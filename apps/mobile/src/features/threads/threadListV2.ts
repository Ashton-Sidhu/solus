// Adapted from T3 Code apps/mobile/src/features/threads/threadListV2.ts (MIT, see UPSTREAM.md).
import { isChat } from "@solus/contracts/chat";
import type { SessionPullRequestLink, SessionPullRequestWatchOutcome } from "@solus/contracts/session-pull-requests";
import type { SessionState } from "@solus/contracts/session-state";
import { worktreeProjectRoot, type SessionRecord, type SessionStatus } from "@solus/contracts/types";

import { relativeTime } from "../../lib/time";
import type { SolusThreadShell } from "./thread-directory";
import { effectiveSnoozed, snoozeWakeLabel } from "./thread-snooze";

/**
 * Thread List v2 model on Solus data. A T3 thread is a Solus session; its
 * list state (settled, snoozed) is the host's `SessionState`; its live status
 * is the last `session.statusChanged` the host sent; its pull requests are the
 * session's links. T3 concepts Solus does not have (pins, a saved arrangement,
 * unsent tasks, archive) are not modelled.
 *
 * Six visual states. Color distinguishes approval, input, active work, and
 * failures. Ready is the unlabeled resting state; waiting is the agent parked
 * on background work (Solus `background`), grey like working rather than a
 * false Done.
 */
export type ThreadListV2Status =
  | "approval"
  | "input"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";
export type ThreadListV2SwipeAction = "settle" | "unsettle" | "snooze" | "unsnooze";

/** The name a session is listed under. */
export function threadTitle(record: Pick<SessionRecord, "customTitle" | "title" | "slug">): string {
  return record.customTitle || record.title || record.slug || "Untitled session";
}

/**
 * The live status wins: the record only knows running or not. A session the
 * host has said nothing about since this client connected reads from its
 * record.
 */
export function resolveThreadListV2Status(
  record: Pick<SessionRecord, "status">,
  liveStatus: SessionStatus | undefined,
): ThreadListV2Status {
  switch (liveStatus) {
    case "awaiting_plan":
      return "approval";
    case "awaiting_input":
      return "input";
    case "connecting":
    case "running":
      return "working";
    case "background":
      return "waiting";
    case "failed":
    case "dead":
      return "failed";
    case "rate_limited":
      return "limited";
    case "idle":
    case "completed":
    case "interrupted":
      return "ready";
    case undefined:
      return record.status === "running" ? "working" : "ready";
  }
}

/** A session blocked on the person may not be hidden: snoozing would defeat
    the request. A running session may be snoozed; it only hides the row. */
export function canSnoozeThread(status: ThreadListV2Status): boolean {
  return status !== "approval" && status !== "input";
}

export function resolveThreadListV2SwipeActions(input: {
  readonly variant: "card" | "slim";
  readonly snoozable: boolean;
  /** Row is on the snoozed shelf. */
  readonly snoozed?: boolean;
}): {
  readonly primary: Exclude<ThreadListV2SwipeAction, "snooze">;
  readonly secondary: "snooze" | null;
} {
  if (input.snoozed === true) {
    return { primary: "unsnooze", secondary: null };
  }
  return {
    primary: input.variant === "slim" ? "unsettle" : "settle",
    secondary: input.snoozable ? "snooze" : null,
  };
}

// Settled-tail paging: recent history is the common lookup; the deep tail
// stays behind an explicit Show more. Shared by the compact Home list and
// the iPad sidebar so both page identically.
export const THREAD_LIST_V2_SETTLED_INITIAL_COUNT = 10;
export const THREAD_LIST_V2_SETTLED_PAGE_COUNT = 25;

/* ─── Projects ───────────────────────────────────────────────────────── */

/** `SolusProjectShell.key` for the project a session belongs to: its git
    root when the host lists that root as a project, else its project path. */
/**
 * The folder a session's project is rooted at. A Claude session's
 * `projectPath` is the provider's encoded storage folder ("-Users-me-solus"),
 * not a path, so the project is read from its root, then from the folder it
 * ran in; the stored name is the last resort.
 */
export function threadProjectPath(record: {
  readonly projectPath: string;
  readonly cwd?: string | null;
  readonly projectRoot?: string | null;
}): string {
  return record.projectRoot || (record.cwd ? worktreeProjectRoot(record.cwd) : "") || record.projectPath;
}

export function threadProjectKey(
  thread: SolusThreadShell,
  projectKeys: ReadonlySet<string>,
): string {
  const rootKey = `${thread.hostId}\u0000${threadProjectPath(thread.record)}`;
  if (projectKeys.has(rootKey)) return rootKey;
  return `${thread.hostId}\u0000${thread.record.projectPath}`;
}

/** The folder whose favicon a thread row shows: the listed project's, else the
    session's own project root, so a project the host does not list (a removed
    project, a dispatch checkout) still shows its mark. A chat has none. */
export function threadFaviconRoot(
  record: { readonly projectPath: string; readonly cwd?: string | null; readonly projectRoot?: string | null },
  listedProjectPath: string | null,
): string | null {
  if (listedProjectPath) return listedProjectPath;
  if (isChat(record.projectPath) || isChat(record.cwd)) return null;
  const path = threadProjectPath(record);
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) ? path : null;
}

/** The project label for a session whose project the host does not list. */
export function threadProjectFallbackTitle(record: SessionRecord): string {
  if (isChat(record.projectPath) || isChat(record.cwd)) return "Chat";
  const path = threadProjectPath(record).replace(/[\\/]+$/, "");
  return path.split(/[\\/]/).at(-1) || path;
}

/* ─── Pull requests ──────────────────────────────────────────────────── */

export interface ThreadPrPresentation {
  readonly number: number;
  readonly state: "open" | "closed" | "merged" | null;
  readonly isDraft: boolean;
  /** Compact pull request number or linked count, e.g. "3774" or "+2". */
  readonly label: string;
  /** Full label for assistive technologies. */
  readonly accessibilityLabel: string;
  readonly textClassName: string;
  /** A link of the session is watched: its agent wakes on news
      (docs/plans/pr-watch.md). */
  readonly isWatched: boolean;
  /** What the row menu's Watch or Stop Watching acts on: the watched link,
      else the badge's link while it may still be open. */
  readonly watchTarget: ThreadPrWatchTarget | null;
}

export interface ThreadPrWatchTarget {
  readonly repository: string;
  readonly number: number;
  readonly isWatched: boolean;
}

const PR_STATE_TEXT_CLASS = {
  open: "text-adaptive-emerald-600-400",
  merged: "text-adaptive-violet-600-400",
  closed: "text-foreground-muted",
} as const;

/**
 * The badge a row draws for its session's links: the open one most recently
 * linked, else the newest. Several links read as "+N". A link PR sync has not
 * answered yet draws with no state.
 */
export function presentThreadPullRequests(
  links: ReadonlyArray<SessionPullRequestLink> | undefined,
): ThreadPrPresentation | null {
  const present = (links ?? []).filter((link) => link.missing !== true);
  if (present.length === 0) return null;
  const newestFirst = [...present].sort((left, right) => right.linkedAt - left.linkedAt);
  const link =
    newestFirst.find((candidate) => candidate.snapshot?.state === "open") ?? newestFirst[0]!;
  const state = link.snapshot?.state ?? null;
  const isDraft = state === "open" && link.snapshot?.draft === true;
  const multiple = present.length > 1;
  const watched = present.find((candidate) => candidate.watch !== undefined);
  const watchable = watched ?? (state === "open" || state === null ? link : undefined);
  return {
    number: link.number,
    state,
    isDraft,
    label: multiple ? `+${present.length}` : String(link.number),
    accessibilityLabel: multiple
      ? `${present.length} linked pull requests`
      : `#${link.number} pull request ${state === null ? "status pending" : isDraft ? "draft" : state}`,
    textClassName:
      state === null || isDraft ? "text-foreground-muted" : PR_STATE_TEXT_CLASS[state],
    isWatched: watched !== undefined,
    watchTarget: watchable
      ? { repository: watchable.repository, number: watchable.number, isWatched: watchable === watched }
      : null,
  };
}

/** Why the host did not start a watch, or null when the request is done. */
export function watchRefusalMessage(outcome: SessionPullRequestWatchOutcome): string | null {
  switch (outcome) {
    case "started":
    case "already-watching":
    case "stopped":
      return null;
    case "session-settled":
      return "This thread is settled. Un-settle it to watch its pull request.";
    case "not-linked":
      return "This pull request is no longer linked to the thread.";
    case "missing":
      return "The code host no longer has this pull request.";
    case "merged":
    case "closed":
      return `This pull request is ${outcome}, so there is nothing to watch.`;
  }
}

/* ─── List model ─────────────────────────────────────────────────────── */

export interface ThreadListV2Item {
  readonly thread: SolusThreadShell;
  readonly variant: "card" | "slim";
  /** Snoozed-shelf row: shows the wake countdown and offers Wake. */
  readonly snoozed: boolean;
  readonly isLast: boolean;
}

export interface ThreadListV2Layout {
  readonly items: ThreadListV2Item[];
  /** Settled threads beyond the render limit (behind "Show more"). */
  readonly hiddenSettledCount: number;
  /** Snoozed threads matching the current filters. */
  readonly snoozedCount: number;
  /** Index in `items` where the Snoozed shelf header belongs. The header is
      still rendered when the shelf is collapsed and no snoozed rows exist. */
  readonly snoozedShelfHeaderIndex: number | null;
  /** Total settled threads in scope, including rows hidden by collapse/paging. */
  readonly settledCount: number;
  /** Index in `items` where the Settled shelf header belongs. */
  readonly settledShelfHeaderIndex: number | null;
  /** Soonest wake time among snoozed threads, or null. Callers arm a timeout
      at this boundary so the list re-partitions the moment a snooze expires
      instead of on the next minute tick. */
  readonly nextSnoozeWakeAt: number | null;
}

export interface ThreadListV2ThreadListItem {
  readonly type: "v2-thread";
  readonly key: string;
  readonly item: ThreadListV2Item;
  /** The live status, carried on the item so a status event reaches a
      recycled row through list equality. */
  readonly status: ThreadListV2Status;
  readonly pr: ThreadPrPresentation | null;
  /** Precomputed so recycled-list equality can see a minute-tick change. */
  readonly snoozeWakeLabelText: string | undefined;
  /** Row timestamp precomputed against the parent clock. Blank while the row
      renders a status label or the wake countdown instead. */
  readonly timeLabel: string;
  /** Minute clock feeding the row's snooze menu, carried only on rows whose
      menu holds snooze presets. */
  readonly snoozePresetMinute: string | undefined;
  /** Inset hairline drawn under the row. */
  readonly showTrailingDivider: boolean;
}

export interface ThreadListV2SnoozedShelfListItem {
  readonly type: "v2-snoozed-shelf";
  readonly key: "v2-snoozed-shelf";
  readonly count: number;
  readonly expanded: boolean;
  readonly disabled: boolean;
}

export interface ThreadListV2SettledShelfListItem {
  readonly type: "v2-settled-shelf";
  readonly key: "v2-settled-shelf";
  readonly count: number;
  readonly expanded: boolean;
  readonly disabled: boolean;
}

export type ThreadListV2ListItem =
  | ThreadListV2ThreadListItem
  | ThreadListV2SnoozedShelfListItem
  | ThreadListV2SettledShelfListItem;

/** Narrows a wider list-item union (e.g. the sidebar's show-more row) to the
    v2 item kinds the shared equality understands. */
export function isThreadListV2ListItem(value: {
  readonly type: string;
}): value is ThreadListV2ListItem {
  return (
    value.type === "v2-thread" ||
    value.type === "v2-snoozed-shelf" ||
    value.type === "v2-settled-shelf"
  );
}

/** A reload rebuilds every shell; a row only re-renders when what it draws
    changed. */
function sameThreadRow(previous: SolusThreadShell, next: SolusThreadShell): boolean {
  if (previous === next) return true;
  const a = previous.record;
  const b = next.record;
  return (
    previous.key === next.key &&
    previous.hostLabel === next.hostLabel &&
    a.title === b.title &&
    a.customTitle === b.customTitle &&
    a.slug === b.slug &&
    a.status === b.status &&
    a.branch === b.branch &&
    a.provider === b.provider &&
    a.projectPath === b.projectPath &&
    a.projectRoot === b.projectRoot &&
    a.lastActivityAt === b.lastActivityAt
  );
}

function samePr(previous: ThreadPrPresentation | null, next: ThreadPrPresentation | null): boolean {
  if (previous === next) return true;
  if (previous === null || next === null) return false;
  return (
    previous.label === next.label &&
    previous.state === next.state &&
    previous.isDraft === next.isDraft &&
    previous.number === next.number
  );
}

/** Recycled-list equality for the flat v2 list (Home + iPad sidebar). */
export function threadListV2ListItemsAreEqual(
  previous: ThreadListV2ListItem,
  item: ThreadListV2ListItem,
): boolean {
  switch (item.type) {
    case "v2-thread":
      return (
        previous.type === "v2-thread" &&
        previous.key === item.key &&
        sameThreadRow(previous.item.thread, item.item.thread) &&
        previous.item.variant === item.item.variant &&
        previous.item.snoozed === item.item.snoozed &&
        previous.status === item.status &&
        samePr(previous.pr, item.pr) &&
        previous.snoozeWakeLabelText === item.snoozeWakeLabelText &&
        previous.timeLabel === item.timeLabel &&
        previous.snoozePresetMinute === item.snoozePresetMinute &&
        previous.showTrailingDivider === item.showTrailingDivider
      );
    case "v2-snoozed-shelf":
      return (
        previous.type === "v2-snoozed-shelf" &&
        previous.count === item.count &&
        previous.expanded === item.expanded &&
        previous.disabled === item.disabled
      );
    case "v2-settled-shelf":
      return (
        previous.type === "v2-settled-shelf" &&
        previous.count === item.count &&
        previous.expanded === item.expanded &&
        previous.disabled === item.disabled
      );
  }
}

/** What the list knows about every session beyond its record. */
export interface ThreadListV2Facts {
  /** `SessionState` by thread key; a session with none is active. */
  readonly shelf: ReadonlyMap<string, SessionState>;
  /** Last live status by thread key. */
  readonly liveStatus: ReadonlyMap<string, SessionStatus>;
  /** Pull request links by thread key. */
  readonly pullRequests: ReadonlyMap<string, ReadonlyArray<SessionPullRequestLink>>;
}

/**
 * Builds the shared mobile order: active → snoozed shelf → settled. Parked
 * work remains reachable without competing with either the inbox or settled
 * history.
 */
export function buildThreadListV2ListItems(input: {
  readonly items: ReadonlyArray<ThreadListV2Item>;
  readonly facts: ThreadListV2Facts;
  readonly snoozedCount?: number;
  readonly snoozedShelfExpanded?: boolean;
  readonly snoozedShelfHeaderIndex?: number | null;
  readonly settledCount?: number;
  readonly settledShelfExpanded?: boolean;
  readonly settledShelfHeaderIndex?: number | null;
  /** The minute clock, epoch milliseconds. */
  readonly now: number;
  /** True while the shelf expansion preferences are still loading. */
  readonly shelfPreferencesLoading?: boolean;
}): ThreadListV2ListItem[] {
  const threadItems = input.items.map((item): ThreadListV2ListItem => {
    const key = item.thread.key;
    const state = input.facts.shelf.get(key);
    const status = resolveThreadListV2Status(item.thread.record, input.facts.liveStatus.get(key));
    const snoozeWakeLabelText =
      item.snoozed && state?.snoozedUntil != null
        ? snoozeWakeLabel(state.snoozedUntil, input.now)
        : undefined;
    const snoozePresetMinute =
      !item.snoozed && canSnoozeThread(status) ? String(input.now) : undefined;
    return {
      type: "v2-thread",
      key: `v2-thread:${key}`,
      item,
      status,
      pr: presentThreadPullRequests(input.facts.pullRequests.get(key)),
      snoozeWakeLabelText,
      timeLabel: resolveThreadListV2ItemTimeLabel(item, status, state, snoozeWakeLabelText !== undefined),
      snoozePresetMinute,
      showTrailingDivider: false,
    };
  });
  const snoozedCount = input.snoozedCount ?? 0;
  const snoozedShelfHeaderIndex = input.snoozedShelfHeaderIndex ?? null;
  const settledCount = input.settledCount ?? 0;
  const settledShelfHeaderIndex = input.settledShelfHeaderIndex ?? null;
  const activeEnd = snoozedShelfHeaderIndex ?? settledShelfHeaderIndex ?? threadItems.length;
  const snoozedEnd = settledShelfHeaderIndex ?? threadItems.length;
  const result: ThreadListV2ListItem[] = threadItems.slice(0, activeEnd);
  const shelfDisabled = input.shelfPreferencesLoading === true;
  if (snoozedShelfHeaderIndex !== null && snoozedCount > 0) {
    result.push({
      type: "v2-snoozed-shelf",
      key: "v2-snoozed-shelf",
      count: snoozedCount,
      expanded: input.snoozedShelfExpanded === true,
      disabled: shelfDisabled,
    });
    result.push(...threadItems.slice(snoozedShelfHeaderIndex, snoozedEnd));
  }
  if (settledShelfHeaderIndex !== null && settledCount > 0) {
    result.push({
      type: "v2-settled-shelf",
      key: "v2-settled-shelf",
      count: settledCount,
      expanded: input.settledShelfExpanded !== false,
      disabled: shelfDisabled,
    });
    result.push(...threadItems.slice(settledShelfHeaderIndex));
  }
  // Hairlines depend on the final neighbour, so they are stamped after the
  // splice: a recycled cell only re-renders when its divider actually flips.
  return result.map((entry, index) => {
    if (entry.type !== "v2-thread") return entry;
    const showTrailingDivider = result[index + 1]?.type === "v2-thread";
    return showTrailingDivider === entry.showTrailingDivider
      ? entry
      : { ...entry, showTrailingDivider };
  });
}

/** The timestamp a row renders when it shows no status label: the settle
    stamp on settled slim rows, otherwise the latest activity. */
function resolveThreadListV2ItemTimeLabel(
  item: ThreadListV2Item,
  status: ThreadListV2Status,
  state: SessionState | undefined,
  showSnoozeWakeLabel: boolean,
): string {
  if (showSnoozeWakeLabel) return "";
  if (item.variant === "card" && status !== "ready") return "";
  const settledAt = item.variant === "slim" && !item.snoozed ? (state?.settledAt ?? null) : null;
  return relativeTime(new Date(settledAt ?? item.thread.record.lastActivityAt).toISOString());
}

function matchesSearch(
  thread: SolusThreadShell,
  query: string,
  links: ReadonlyArray<SessionPullRequestLink> | undefined,
): boolean {
  if (query.length === 0) return true;
  const terms = [
    threadTitle(thread.record),
    thread.record.branch ?? "",
    ...(links ?? []).flatMap((link) => [`#${link.number}`, link.title]),
  ];
  return terms.some((term) => term.toLocaleLowerCase().includes(query));
}

/**
 * Partitions visible threads into the active card block and the snoozed and
 * settled shelves. Active threads keep creation order, newest first, so a
 * working thread never jumps; settled threads read newest settle first.
 */
export function buildThreadListV2Items(input: {
  readonly threads: ReadonlyArray<SolusThreadShell>;
  readonly facts: ThreadListV2Facts;
  readonly hostId: string | null;
  /** Project keys of the selected project scope, or null for every project. */
  readonly projectKeys?: ReadonlySet<string> | null;
  /** Every listed project's key, to place a session under its git root. */
  readonly knownProjectKeys?: ReadonlySet<string>;
  readonly searchQuery: string;
  /** Max settled rows to render; the rest are counted, not built. */
  readonly settledLimit?: number;
  /** Epoch milliseconds used for time-based classification. */
  readonly now: number;
  /** Expands the snoozed shelf into rows. Collapsed is the default. */
  readonly snoozedShelfExpanded?: boolean;
  /** Expands the settled shelf into rows. Expanded is the default. */
  readonly settledShelfExpanded?: boolean;
  /** The selected thread remains visible on an otherwise collapsed shelf so
      a split-view detail can never lose its navigation row. */
  readonly selectedThreadKey?: string | null;
}): ThreadListV2Layout {
  const now = input.now;
  const query = input.searchQuery.trim().toLocaleLowerCase();
  const knownProjectKeys = input.knownProjectKeys ?? new Set<string>();

  const active: SolusThreadShell[] = [];
  const settled: SolusThreadShell[] = [];
  const snoozed: SolusThreadShell[] = [];
  let nextSnoozeWakeAt: number | null = null;
  for (const thread of input.threads) {
    if (input.hostId !== null && thread.hostId !== input.hostId) continue;
    if (
      input.projectKeys != null &&
      !input.projectKeys.has(threadProjectKey(thread, knownProjectKeys))
    ) {
      continue;
    }
    if (!matchesSearch(thread, query, input.facts.pullRequests.get(thread.key))) continue;
    const state = input.facts.shelf.get(thread.key);
    // Snooze outranks settlement until the thread wakes.
    if (effectiveSnoozed(state, now)) {
      snoozed.push(thread);
      const wakeAt = state!.snoozedUntil!;
      if (nextSnoozeWakeAt === null || wakeAt < nextSnoozeWakeAt) nextSnoozeWakeAt = wakeAt;
      continue;
    }
    if (state?.settledAt != null) {
      settled.push(thread);
    } else {
      active.push(thread);
    }
  }

  const orderedActive = [...active].sort(
    (left, right) => right.record.createdAt - left.record.createdAt,
  );
  const shelfTime = (thread: SolusThreadShell, field: "settledAt" | "snoozedUntil") =>
    input.facts.shelf.get(thread.key)?.[field] ?? 0;
  const orderedSnoozed = [...snoozed].sort(
    (left, right) => shelfTime(left, "snoozedUntil") - shelfTime(right, "snoozedUntil"),
  );
  const selectedThreadKey = input.selectedThreadKey ?? null;
  const visibleSnoozed =
    input.snoozedShelfExpanded === true
      ? orderedSnoozed
      : orderedSnoozed.filter((thread) => thread.key === selectedThreadKey);
  const orderedSettled = [...settled].sort(
    (left, right) => shelfTime(right, "settledAt") - shelfTime(left, "settledAt"),
  );
  const settledLimit = input.settledLimit ?? Number.POSITIVE_INFINITY;
  const pagedSettled =
    orderedSettled.length > settledLimit ? orderedSettled.slice(0, settledLimit) : orderedSettled;
  const selectedSettled = orderedSettled
    .slice(pagedSettled.length)
    .find((thread) => thread.key === selectedThreadKey);
  if (selectedSettled !== undefined) pagedSettled.push(selectedSettled);
  const visibleSettled =
    input.settledShelfExpanded !== false
      ? pagedSettled
      : pagedSettled.filter((thread) => thread.key === selectedThreadKey);

  const items: ThreadListV2Item[] = [];
  for (const thread of orderedActive) {
    items.push({ thread, variant: "card", snoozed: false, isLast: false });
  }
  const snoozedShelfHeaderIndex = orderedSnoozed.length > 0 ? items.length : null;
  for (const thread of visibleSnoozed) {
    items.push({ thread, variant: "slim", snoozed: true, isLast: false });
  }
  const settledShelfHeaderIndex = orderedSettled.length > 0 ? items.length : null;
  for (const thread of visibleSettled) {
    items.push({ thread, variant: "slim", snoozed: false, isLast: false });
  }
  const last = items.at(-1);
  if (last) {
    items[items.length - 1] = { ...last, isLast: true };
  }
  return {
    items,
    hiddenSettledCount: orderedSettled.length - pagedSettled.length,
    snoozedCount: orderedSnoozed.length,
    snoozedShelfHeaderIndex,
    settledCount: orderedSettled.length,
    settledShelfHeaderIndex,
    nextSnoozeWakeAt,
  };
}
