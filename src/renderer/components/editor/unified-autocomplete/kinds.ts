/*
 * The `#` namespace: every noun in the workspace that isn't a file.
 *
 * `slug` is a stable public string. Drilling into a category writes it into the
 * composer text (`#automations/`), so it is parsed back out rather than held in
 * component state — see `trigger.ts`.
 */

export type RefKind =
  | "plan"
  | "doc"
  | "pr"
  | "session"
  | "task"
  | "automation";

export interface KindSpec {
  key: RefKind;
  slug: string;
  label: string;
  /** 14×14 stroked glyph, drawn at 13px / 1.4 stroke in every row. */
  icon: string;
}

/** Glyphs shared by menu rows. One path string may hold several subpaths. */
export const GLYPH = {
  cmd: "M8.7 2.1L5.3 11.9",
  file: "M3.4 1.8h4.4l2.8 2.8v7.6H3.4z M7.8 1.9v2.7h2.7",
  folder:
    "M1.8 3.6a1.2 1.2 0 011.2-1.2h2.2l1.2 1.4h4.6a1.2 1.2 0 011.2 1.2v5a1.2 1.2 0 01-1.2 1.2H3a1.2 1.2 0 01-1.2-1.2z",
  plan: "M2 3.6l1.4 1.4L6 2.4M8 3.6h4M2 9.6l1.4 1.4L6 8.4M8 9.6h4",
  pr: "M4 3.2a1.4 1.4 0 100-2.8 1.4 1.4 0 000 2.8M4 13.4a1.4 1.4 0 100-2.8 1.4 1.4 0 000 2.8M10.4 3.2a1.4 1.4 0 100-2.8 1.4 1.4 0 000 2.8M4 3.4v7.2M10.4 3.4v2.6a2.6 2.6 0 01-2.6 2.6H6",
  session:
    "M12 8.2a1.8 1.8 0 01-1.8 1.8H5.4L2.6 12.4V3.6a1.8 1.8 0 011.8-1.8h5.8A1.8 1.8 0 0112 3.6z",
  task: "M2.4 3.6a1.2 1.2 0 011.2-1.2h6.8a1.2 1.2 0 011.2 1.2v6.8a1.2 1.2 0 01-1.2 1.2H3.6a1.2 1.2 0 01-1.2-1.2z M4.9 7l1.6 1.6 2.9-3.2",
  automation: "M7.7 1.9L3.5 8h3.1l-.6 4.1L10.5 6H7.3z",
  chevron: "M5.4 3.6L8.8 7l-3.4 3.4",
} as const;

/** Menu order at the `#` root, and the order the "Recent" band samples in. */
export const KINDS: readonly KindSpec[] = [
  { key: "plan", slug: "plans", label: "Plans", icon: GLYPH.plan },
  { key: "doc", slug: "docs", label: "Docs", icon: GLYPH.file },
  { key: "pr", slug: "prs", label: "Pull requests", icon: GLYPH.pr },
  { key: "session", slug: "sessions", label: "Sessions", icon: GLYPH.session },
  { key: "task", slug: "tasks", label: "Tasks", icon: GLYPH.task },
  {
    key: "automation",
    slug: "automations",
    label: "Automations",
    icon: GLYPH.automation,
  },
];

/** Singular noun used when a row has to say what it is ("Pull request · open"). */
export const KIND_NOUN: Record<RefKind, string> = {
  plan: "Plan",
  doc: "Doc",
  pr: "Pull request",
  session: "Session",
  task: "Task",
  automation: "Automation",
};

/** Both the slug and the singular kind key resolve, so `#pr/` works like `#prs/`. */
export function kindForSlug(slug: string): KindSpec | null {
  const normalized = slug.toLowerCase();
  return (
    KINDS.find(
      (kind) => kind.slug === normalized || kind.key === normalized,
    ) ?? null
  );
}

export function kindFor(key: RefKind): KindSpec {
  return KINDS.find((kind) => kind.key === key)!;
}
