/*
 * One popover, one row grammar. Categories and items differ only by their
 * leading glyph and trailing slot; the trailing slot carries exactly one thing
 * per row kind — a count on a category, freshness or state on an item.
 *
 * Building rows is pure: the controller collects the indexes, this decides what
 * the menu shows. Every zero-result state still produces a row, so no query,
 * however typed, can produce an empty popover.
 */
import type { SlashCommand } from "../../input/slash-commands";
import type { ReferenceToken } from "../reference-tokens";
import { KINDS, KIND_NOUN, kindFor, GLYPH, type RefKind } from "./kinds";
import { rank, highlightParts, type Ranked, type TitlePart } from "./rank";
import type { Trigger } from "./trigger";

export interface MenuItem {
  /** Stable row identity for keying. */
  id: string;
  title: string;
  /** Ellipsised secondary text — status, path, trigger summary. */
  meta: string;
  /** Trailing slot: freshness or state. Never set alongside a count. */
  when: string;
  icon: string;
  /** Names you can type are mono; prose titles are not. */
  mono: boolean;
  monoMeta: boolean;
  /** What accepting this row puts in the composer. */
  token: ReferenceToken;
  /** Absolute directory used only to browse deeper with Tab. */
  directoryPath?: string;
  /** Set on `/` rows the host may need to execute rather than insert. */
  command?: SlashCommand;
  /** Present for `#` rows so the metadata pass can match the noun. */
  kindNoun?: string;
  refKind?: RefKind;
  /** Extra context shown only for the selected row. Kept out of the compact
   *  result geometry so large indexes remain quick to scan. */
  preview?: string;
}

export type MenuRow =
  | { type: "label"; key: string; label: string; hint: string }
  | { type: "header"; key: string; label: string; meta: string; icon: string }
  | {
      type: "category";
      key: string;
      kind: RefKind;
      label: string;
      icon: string;
      count: string;
      parts: TitlePart[];
    }
  | {
      type: "item";
      key: string;
      item: MenuItem;
      parts: TitlePart[];
      /** Show the kind noun ahead of the metadata, in cross-kind bands. */
      showKind: boolean;
    }
  | {
      type: "deadEnd";
      key: string;
      title: string;
      meta: string;
      icon: string;
      /** What ⏎ does here: widen the search, or leave the scope. */
      action: "clear" | "back";
    };

/** Rows the caret can land on. Labels and the header row are skipped. */
export type SelectableRow = Extract<
  MenuRow,
  { type: "category" | "item" | "deadEnd" }
>;

export function isSelectable(row: MenuRow): row is SelectableRow {
  return row.type === "category" || row.type === "item" || row.type === "deadEnd";
}

/** Slash commands read as one typed token (`/clear`), not an icon and label. */
export function inlineTitlePrefix(row: SelectableRow): string {
  return row.type === "item" && row.item.token.kind === "slash" ? "/" : "";
}

export interface RowInput {
  trigger: Trigger;
  /** `/` channel. Already filtered to what this provider offers. */
  commands: MenuItem[];
  /** `@` channel, split into the two bands. */
  openFiles: MenuItem[];
  worktreeFiles: MenuItem[];
  /** Total files searchable, for the band's count hint. */
  worktreeFileCount: number | null;
  /** `#` channel, per category, each already in recency order. */
  byKind: Record<RefKind, MenuItem[]>;
  /** Workspace totals shown in the trailing slot of a category row. */
  counts: Record<RefKind, number>;
}

const MAX_IN_KIND = 5;
const MAX_ELSEWHERE = 3;
const MAX_BEST = 8;
const MAX_DRILLED = 8;
const MAX_RECENT = 4;

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** "5" when everything fits, "5 of 23" when the band is capped. */
function bandHint(total: number, cap: number): string {
  return total > cap ? `${cap} of ${total}` : String(total);
}

function itemRow(
  ranked: Ranked<MenuItem>,
  showKind: boolean,
  bandKey: string,
): MenuRow {
  return {
    type: "item",
    key: `${bandKey}:${ranked.item.id}`,
    item: ranked.item,
    parts: ranked.parts,
    showKind,
  };
}

function uniqueItemsById(items: MenuItem[]): MenuItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export function buildRows(input: RowInput): MenuRow[] {
  const { trigger } = input;
  if (trigger.char === "/") return commandRows(input);
  if (trigger.char === "@") return fileRows(input);
  if (trigger.path.length === 1) return drilledRows(input, trigger.path[0]);
  return referenceRootRows(input);
}

function commandRows(input: RowInput): MenuRow[] {
  const matches = rank(uniqueItemsById(input.commands), input.trigger.query);
  if (matches.length === 0)
    return [
      {
        type: "deadEnd",
        key: "no-command",
        title: `No command named ${input.trigger.query}`,
        meta: "keep typing as plain text",
        icon: GLYPH.cmd,
        action: "clear",
      },
    ];
  return matches.map((match) => itemRow(match, false, "cmd"));
}

function fileRankQuery(query: string): string {
  const slash = query.lastIndexOf("/");
  return slash >= 0 ? query.slice(slash + 1) : query;
}

function fileRows(input: RowInput): MenuRow[] {
  const { query } = input.trigger;
  const rankQuery = fileRankQuery(query);
  const open = rank(input.openFiles, rankQuery);
  // searchFiles already returns the complete page in match-score order. Keep
  // that page intact: a second client-side fuzzy pass both capped the old full
  // list and discarded path matches that fff had deliberately returned.
  const worktree = rank(input.worktreeFiles, "");
  const rows: MenuRow[] = [];

  if (open.length > 0) {
    rows.push({
      type: "label",
      key: "open",
      label: "Open in this session",
      hint: "",
    });
    rows.push(...open.map((match) => itemRow(match, false, "open")));
  }
  if (worktree.length > 0) {
    rows.push({
      type: "label",
      key: "worktree",
      label: "Files",
      hint:
        input.worktreeFileCount === null
          ? ""
          : formatCount(input.worktreeFileCount),
    });
    rows.push(
      ...worktree.map((match) => itemRow(match, false, "worktree")),
    );
  }
  if (rows.length === 0)
    rows.push({
      type: "deadEnd",
      key: "no-file",
      title: query ? `No file matches ${query}` : "No files here",
      meta: "keep typing as plain text",
      icon: GLYPH.folder,
      action: "clear",
    });
  return rows;
}

function drilledRows(input: RowInput, kindKey: RefKind): MenuRow[] {
  const kind = kindFor(kindKey);
  const { query } = input.trigger;
  const rows: MenuRow[] = [
    {
      type: "header",
      key: `header:${kind.key}`,
      label: kind.label,
      meta: `${formatCount(input.counts[kind.key])} in this workspace`,
      icon: kind.icon,
    },
  ];
  // An empty drill preserves the index's recency order, so do not allocate and
  // rank thousands of results that cannot enter the first visible page.
  const candidates = query
    ? input.byKind[kind.key]
    : input.byKind[kind.key].slice(0, MAX_DRILLED);
  const matches = rank(candidates, query);
  if (matches.length === 0) {
    rows.push({
      type: "deadEnd",
      key: "no-in-kind",
      title: `Nothing in ${kind.label.toLowerCase()} matches ${query}`,
      meta: "search every category",
      icon: kind.icon,
      action: "back",
    });
    return rows;
  }
  // The full category stays in the ranking input, but only a viewport-sized
  // page becomes DOM. Rendering thousands of session buttons made opening an
  // empty drill block the composer even though all but a handful were hidden
  // below the scroll fold. A narrower query can still reach every item.
  rows.push(
    ...matches
      .slice(0, MAX_DRILLED)
      .map((match) => itemRow(match, false, kind.key)),
  );
  return rows;
}

function allReferences(input: RowInput): MenuItem[] {
  return KINDS.flatMap((kind) => input.byKind[kind.key]);
}

function referenceRootRows(input: RowInput): MenuRow[] {
  const { query } = input.trigger;
  if (!query) return referenceBrowseRows(input);

  const lowered = query.toLowerCase();
  const categories = KINDS.filter(
    (kind) =>
      kind.label.toLowerCase().startsWith(lowered) ||
      kind.key.startsWith(lowered) ||
      kind.slug.startsWith(lowered),
  );
  const rows: MenuRow[] = categories.map((kind) => ({
    type: "category",
    key: `cat:${kind.key}`,
    kind: kind.key,
    label: kind.label,
    icon: kind.icon,
    count: formatCount(input.counts[kind.key]),
    parts: highlightParts(kind.label, [
      [0, Math.min(query.length, kind.label.length)],
    ]),
  }));

  const matchedKinds = categories.map((kind) => kind.key);
  let matches = rank(allReferences(input), query);

  // Naming a category is also a way to ask for everything in it, so its members
  // join the results even when the query matches none of their own text.
  if (matchedKinds.length > 0) {
    const seen = new Set(matches.map((match) => match.item.id));
    allReferences(input).forEach((item, index) => {
      if (!item.refKind || !matchedKinds.includes(item.refKind)) return;
      if (seen.has(item.id)) return;
      matches.push({
        item,
        score: 6 + index * 0.001,
        parts: highlightParts(item.title, []),
      });
    });
    matches = matches.sort((left, right) => left.score - right.score);

    const inKind = matches.filter(
      (match) => match.item.refKind && matchedKinds.includes(match.item.refKind),
    );
    const elsewhere = matches.filter(
      (match) =>
        !match.item.refKind || !matchedKinds.includes(match.item.refKind),
    );
    if (inKind.length > 0) {
      rows.push({
        type: "label",
        key: "in-kind",
        label: `In ${categories.map((kind) => kind.label.toLowerCase()).join(" + ")}`,
        hint: bandHint(inKind.length, MAX_IN_KIND),
      });
      rows.push(
        ...inKind.slice(0, MAX_IN_KIND).map((m) => itemRow(m, true, "in")),
      );
    }
    if (elsewhere.length > 0) {
      rows.push({
        type: "label",
        key: "elsewhere",
        label: "Elsewhere",
        hint: bandHint(elsewhere.length, MAX_ELSEWHERE),
      });
      rows.push(
        ...elsewhere
          .slice(0, MAX_ELSEWHERE)
          .map((m) => itemRow(m, true, "else")),
      );
    }
  } else if (matches.length > 0) {
    rows.push({
      type: "label",
      key: "best",
      label: "Best matches",
      hint: bandHint(matches.length, MAX_BEST),
    });
    rows.push(...matches.slice(0, MAX_BEST).map((m) => itemRow(m, true, "best")));
  }

  if (rows.length === 0)
    rows.push({
      type: "deadEnd",
      key: "no-ref",
      title: `Nothing matches ${query}`,
      meta: "keep typing as plain text",
      icon: GLYPH.file,
      action: "clear",
    });
  return rows;
}

/** No query: the six categories, then what you last touched across all of them. */
function referenceBrowseRows(input: RowInput): MenuRow[] {
  const rows: MenuRow[] = KINDS.map((kind) => ({
    type: "category",
    key: `cat:${kind.key}`,
    kind: kind.key,
    label: kind.label,
    icon: kind.icon,
    count: formatCount(input.counts[kind.key]),
    parts: [{ text: kind.label, hit: false }],
  }));

  const recent = KINDS.map((kind) => input.byKind[kind.key][0]).filter(
    (item): item is MenuItem => item !== undefined,
  );
  if (recent.length > 0) {
    rows.push({ type: "label", key: "recent", label: "Recent", hint: "" });
    rows.push(
      ...recent.slice(0, MAX_RECENT).map((item) => ({
        type: "item" as const,
        key: `recent:${item.id}`,
        item,
        parts: highlightParts(item.title, []),
        showKind: true,
      })),
    );
  }
  return rows;
}

/*
 * The grey completion drawn ahead of the caret. Offered only when the selected
 * row's title — or, for a category, its slug — starts with the query, so it
 * always equals the text pressing → produces. Category ghosts carry the
 * trailing `/` for the same reason.
 */
export function ghostFor(row: SelectableRow | null, query: string): string {
  if (!row) return "";
  if (row.type === "category") {
    const { slug } = kindFor(row.kind);
    return slug.startsWith(query.toLowerCase())
      ? `${slug.slice(query.length)}/`
      : "";
  }
  if (row.type !== "item" || !query) return "";
  const { title } = row.item;
  return title.toLowerCase().startsWith(query.toLowerCase()) &&
    title.length > query.length
    ? title.slice(query.length)
    : "";
}

/** Metadata shown on a row, prefixed with its noun in cross-kind bands. */
export function rowMeta(item: MenuItem, showKind: boolean): string {
  if (!showKind || !item.refKind) return item.meta;
  const noun = KIND_NOUN[item.refKind];
  return item.meta ? `${noun} · ${item.meta}` : noun;
}
