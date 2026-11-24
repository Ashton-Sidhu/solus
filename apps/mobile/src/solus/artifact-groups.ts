import type { TranscriptItem } from "@solus-mobile/features/conversation/lib/transcript-model";

/**
 * The artifact group card: two or more different saved HTML works that one
 * turn wrote show as one card at the place of the first. A work that the turn
 * wrote more than one time is one tab, at the newest revision of that turn.
 */

export interface ArtifactGroupTab {
  readonly workId: string;
  /** Every revision of the work in the conversation, oldest first. The arrows step through them. */
  readonly revisions: readonly string[];
  /** The number of each revision: its saved content version, else the number after the previous one. */
  readonly versions: readonly number[];
  /** The index in `revisions` of the newest revision that this turn wrote. */
  readonly turnRevision: number;
  /** The work had no revision before this turn. */
  readonly isNew: boolean;
}

export interface ArtifactGroup {
  /** The key of the first member: the card shows at its place. */
  readonly id: string;
  /** In the order that the turn first wrote each work. */
  readonly tabs: readonly ArtifactGroupTab[];
  /** The index of the tab that the agent wrote last in the turn. */
  readonly defaultTab: number;
}

type Lookup = (key: string) => TranscriptItem | undefined;

/** A prompt that the person sees starts a turn. A queued prompt is not shown yet. */
function startsTurn(item: TranscriptItem | undefined): boolean {
  return (
    item?.kind === "user" &&
    !(item.waitsForTurn && (item.delivery === "queued" || item.delivery === "sending"))
  );
}

function groupSignature(group: ArtifactGroup): string {
  return JSON.stringify(group);
}

/**
 * Returns a function that reads the groups of a transcript order, by the key
 * of each member. The first member shows the card; the other members show
 * nothing. A group that did not change keeps its object, so its row is not
 * built again.
 */
export function createArtifactGrouping() {
  let previous = new Map<string, { signature: string; group: ArtifactGroup }>();
  return (order: readonly string[], item: Lookup): ReadonlyMap<string, ArtifactGroup> => {
    const revisions = new Map<string, string[]>();
    const versions = new Map<string, number[]>();
    for (const key of order) {
      const entry = item(key);
      if (entry?.kind !== "artifact" || !entry.workId) continue;
      const keys = revisions.get(entry.workId) ?? [];
      const numbers = versions.get(entry.workId) ?? [];
      numbers.push(entry.contentVersion ?? (numbers.at(-1) ?? 0) + 1);
      keys.push(key);
      revisions.set(entry.workId, keys);
      versions.set(entry.workId, numbers);
    }
    const members = new Map<string, ArtifactGroup>();
    const next = new Map<string, { signature: string; group: ArtifactGroup }>();
    let turn: string[] = [];
    const closeTurn = () => {
      // The newest key of each work in the turn, in the order of first appearance.
      const newest = new Map<string, string>();
      const first = new Map<string, string>();
      for (const key of turn) {
        const workId = (item(key) as Extract<TranscriptItem, { kind: "artifact" }>).workId!;
        if (!first.has(workId)) first.set(workId, key);
        newest.set(workId, key);
      }
      if (newest.size >= 2) {
        const last = turn.at(-1)!;
        const tabs = [...newest].map(([workId, key]): ArtifactGroupTab => {
          const keys = revisions.get(workId)!;
          const numbers = versions.get(workId)!;
          const firstIndex = keys.indexOf(first.get(workId)!);
          return {
            workId,
            revisions: keys,
            versions: numbers,
            turnRevision: keys.indexOf(key),
            isNew: firstIndex === 0 && numbers[0]! <= 1,
          };
        });
        const built: ArtifactGroup = {
          id: turn[0]!,
          tabs,
          defaultTab: tabs.findIndex((tab) => tab.revisions[tab.turnRevision] === last),
        };
        const signature = groupSignature(built);
        const kept = previous.get(built.id);
        const group = kept?.signature === signature ? kept.group : built;
        next.set(group.id, { signature, group });
        for (const key of turn) members.set(key, group);
      }
      turn = [];
    };
    for (const key of order) {
      const entry = item(key);
      if (startsTurn(entry)) closeTurn();
      else if (entry?.kind === "artifact" && entry.workId) turn.push(key);
    }
    closeTurn();
    previous = next;
    return members;
  };
}

/** The counts of the folded line: "3 artifacts · 2 updated · 1 new". */
export function artifactGroupCounts(group: ArtifactGroup) {
  const created = group.tabs.filter((tab) => tab.isNew).length;
  return { artifacts: group.tabs.length, updated: group.tabs.length - created, created };
}

/** The version pill of a revision: "v4 of 4". */
export function artifactVersion(tab: ArtifactGroupTab, revision: number) {
  return { version: tab.versions[revision]!, total: tab.versions.at(-1)! };
}

/**
 * What the person chose in a group card. It is kept outside the row, because
 * a row that scrolls out of the feed list unmounts.
 */
export interface ArtifactGroupView {
  /** The work of the tab the person selected; null follows the tab the agent wrote last. */
  readonly workId: string | null;
  /** The revision the person picked for each work. */
  readonly picked: ReadonlyMap<string, string>;
  readonly folded: boolean;
}

const OPEN_VIEW: ArtifactGroupView = { workId: null, picked: new Map(), folded: false };
const views = new WeakMap<object, Map<string, ArtifactGroupView>>();

/** The view of one group card in one conversation. */
export function artifactGroupView(conversation: object, groupId: string): ArtifactGroupView {
  return views.get(conversation)?.get(groupId) ?? OPEN_VIEW;
}

/** Keeps a change to the view of one group card, and returns the new view. */
export function changeArtifactGroupView(
  conversation: object,
  groupId: string,
  change: Partial<ArtifactGroupView>,
): ArtifactGroupView {
  let byGroup = views.get(conversation);
  if (!byGroup) views.set(conversation, (byGroup = new Map()));
  const view = { ...artifactGroupView(conversation, groupId), ...change };
  byGroup.set(groupId, view);
  return view;
}

/** The view after the person picks a revision of one work. */
export function pickArtifactRevision(
  conversation: object,
  groupId: string,
  workId: string,
  revisionKey: string,
): ArtifactGroupView {
  const picked = new Map(artifactGroupView(conversation, groupId).picked).set(workId, revisionKey);
  return changeArtifactGroupView(conversation, groupId, { picked });
}

/** The tab that shows: the one the person selected while it is in the group, else the default. */
export function selectedTab(group: ArtifactGroup, view: Pick<ArtifactGroupView, "workId">): number {
  const index = view.workId ? group.tabs.findIndex((tab) => tab.workId === view.workId) : -1;
  return index >= 0 ? index : group.defaultTab;
}

/** The revision that shows in a tab: the one the person picked, else the newest of the turn. */
export function selectedRevision(
  tab: ArtifactGroupTab,
  view: Pick<ArtifactGroupView, "picked">,
): number {
  const picked = view.picked.get(tab.workId);
  const index = picked ? tab.revisions.indexOf(picked) : -1;
  return index >= 0 ? index : tab.turnRevision;
}
