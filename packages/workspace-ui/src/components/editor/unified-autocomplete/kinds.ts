/*
 * The `#` namespace: every noun in the workspace that isn't a file.
 *
 * `slug` is a stable public string. Drilling into a category writes it into the
 * composer text (`#automations/`), so it is parsed back out rather than held in
 * component state — see `trigger.ts`.
 */

import { githubOcticonPaths } from "@solus/client-core/github-octicons";

export type RefKind =
  | "plan"
  | "doc"
  | "pr"
  | "session"
  | "task"
  | "automation"
  | "host";

export interface KindSpec {
  key: RefKind;
  slug: string;
  label: string;
  /** SVG path for the leading icon. */
  icon: string;
}

/** Glyphs shared by menu rows. One path string may hold several subpaths. */
export const GLYPH = {
  cmd: "M8.7 2.1L5.3 11.9",
  file: "M3.4 1.8h4.4l2.8 2.8v7.6H3.4z M7.8 1.9v2.7h2.7",
  folder:
    "M1.8 3.6a1.2 1.2 0 011.2-1.2h2.2l1.2 1.4h4.6a1.2 1.2 0 011.2 1.2v5a1.2 1.2 0 01-1.2 1.2H3a1.2 1.2 0 01-1.2-1.2z",
  plan: "M2 3.6l1.4 1.4L6 2.4M8 3.6h4M2 9.6l1.4 1.4L6 8.4M8 9.6h4",
  pr: githubOcticonPaths.pullRequest,
  session:
    "M12 8.2a1.8 1.8 0 01-1.8 1.8H5.4L2.6 12.4V3.6a1.8 1.8 0 011.8-1.8h5.8A1.8 1.8 0 0112 3.6z",
  task: githubOcticonPaths.issueOpened,
  automation: "M1.75 2.9a1.15 1.15 0 0 1 1.15-1.15h2.37A1.15 1.15 0 0 1 6.42 2.9v2.37a1.15 1.15 0 0 1-1.15 1.15H2.9a1.15 1.15 0 0 1-1.15-1.15z M4.08 6.42v2.33a1.17 1.17 0 0 0 1.17 1.17h2.33 M7.58 8.73a1.15 1.15 0 0 1 1.15-1.15h2.37a1.15 1.15 0 0 1 1.15 1.15v2.37a1.15 1.15 0 0 1-1.15 1.15H8.73a1.15 1.15 0 0 1-1.15-1.15z",
  host: "M2.4 2.8a1 1 0 011-1h7.2a1 1 0 011 1v2.2a1 1 0 01-1 1H3.4a1 1 0 01-1-1z M2.4 9a1 1 0 011-1h7.2a1 1 0 011 1v2.2a1 1 0 01-1 1H3.4a1 1 0 01-1-1z M4.4 3.9h.7 M4.4 10.1h.7",
  person:
    "M7 7.2a2.4 2.4 0 100-4.8 2.4 2.4 0 000 4.8M2.6 12.2a4.4 4.4 0 018.8 0",
  chevron: "M5.4 3.6L8.8 7l-3.4 3.4",
  /** An MCP resource: a document on a server's stack. */
  resource: "M3.4 1.8h5.2l2 2v5.4H3.4z M8.6 1.9v1.9h1.9 M5.2 11.2v1h5.6a1 1 0 001-1V5.6",
} as const;

/** Menu order at the `#` root, and the order the "Recent" band samples in. */
export const KINDS: readonly KindSpec[] = [
  { key: "plan", slug: "plans", label: "Plans", icon: GLYPH.plan },
  { key: "doc", slug: "docs", label: "Docs", icon: GLYPH.file },
  { key: "pr", slug: "prs", label: "Pull requests", icon: GLYPH.pr },
  { key: "session", slug: "sessions", label: "Sessions", icon: GLYPH.session },
  { key: "task", slug: "tasks", label: "Issues", icon: GLYPH.task },
  {
    key: "automation",
    slug: "automations",
    label: "Automations",
    icon: GLYPH.automation,
  },
  { key: "host", slug: "hosts", label: "Hosts", icon: GLYPH.host },
];

/** Singular noun used when a row has to say what it is ("Pull request · open"). */
export const KIND_NOUN = {
  plan: "Plan",
  doc: "Doc",
  pr: "Pull request",
  session: "Session",
  task: "Issue",
  automation: "Automation",
  host: "Host",
} satisfies Record<RefKind, string>;

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
