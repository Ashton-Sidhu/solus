/**
 * What the project panel shows. The person's choice is the synced personal
 * setting `projectPanelHiddenItems`: only the items they turned off, so an
 * empty list is the default and every item shows. The list keeps ids this
 * client does not know, so an older and a newer client never erase each
 * other's choices.
 *
 * Every section can hide, and so can each kind of row in it. A section shows
 * while it is on and at least one of its rows is. Webhooks lists one row per
 * webhook, so it has no row kinds to choose.
 */

export const PROJECT_PANEL_SECTIONS = [
  {
    id: "environment",
    label: "Environment",
    rows: [
      { id: "environment.project", label: "Project" },
      { id: "environment.terminal", label: "Terminal" },
      { id: "environment.view", label: "Browser, builds, and artifacts" },
      { id: "environment.usage", label: "Usage" },
    ],
  },
  {
    id: "git",
    label: "Git",
    rows: [
      { id: "git.branch", label: "Branch" },
      { id: "git.commit", label: "Commit and push" },
      { id: "git.changes", label: "Changes" },
      { id: "git.pullRequestAction", label: "Create or sync pull request" },
      { id: "git.discard", label: "Discard changes" },
      { id: "git.conflicts", label: "Merge conflicts" },
      { id: "git.pullRequest", label: "Linked pull request" },
      { id: "git.otherPullRequests", label: "Also linked" },
      { id: "git.setup", label: "Repository setup" },
    ],
  },
  {
    id: "goal",
    label: "Goal",
    rows: [
      { id: "goal.objective", label: "Objective" },
      { id: "goal.details", label: "Cost and time" },
      { id: "goal.budget", label: "Token budget" },
    ],
  },
  {
    id: "agents",
    label: "Agents",
    rows: [
      { id: "agents.running", label: "Running agents" },
      { id: "agents.previous", label: "Previous agents" },
    ],
  },
  { id: "webhooks", label: "Webhooks", rows: [] },
] as const

export type PanelSection = (typeof PROJECT_PANEL_SECTIONS)[number]
export type PanelSectionId = PanelSection["id"]
export type PanelRowId = PanelSection["rows"][number]["id"]
export type ProjectPanelItemId = PanelSectionId | PanelRowId

export function isPanelItemShown(hidden: readonly string[], id: ProjectPanelItemId): boolean {
  return !hidden.includes(id)
}

/** The hidden list after one item changes. Every other id stays, in its order. */
export function withPanelItemShown(hidden: readonly string[], id: ProjectPanelItemId, shown: boolean): string[] {
  const others = hidden.filter((hiddenId) => hiddenId !== id)
  return shown ? others : [...others, id]
}

/** The Git section's action rows, by the key each row already carries. */
const GIT_ACTION_ROW_IDS = new Map<string, PanelRowId>([
  ["commit", "git.commit"],
  ["changes", "git.changes"],
  ["pull-requests", "git.pullRequestAction"],
  ["discard", "git.discard"],
  ["conflict", "git.conflicts"],
])

/** True unless the person hid this Git action row. A key with no choice always shows. */
export function isGitActionRowShown(hidden: readonly string[], key: string): boolean {
  const id = GIT_ACTION_ROW_IDS.get(key)
  return !id || !hidden.includes(id)
}

/** True while the section is on and has a row to show. A hidden section
 *  unmounts, so its reads stop with it. */
export function isSectionShown(hidden: readonly string[], id: PanelSectionId): boolean {
  if (hidden.includes(id)) return false
  const section = PROJECT_PANEL_SECTIONS.find((candidate) => candidate.id === id)
  const rows: readonly { id: string }[] = section?.rows ?? []
  return rows.length === 0 || rows.some((row) => !hidden.includes(row.id))
}

/** True when the panel has no section to show: it shows an empty state instead. */
export function allPanelItemsHidden(hidden: readonly string[]): boolean {
  return PROJECT_PANEL_SECTIONS.every((section) => !isSectionShown(hidden, section.id))
}

/** How many rows of a section show, for the menu's count. */
export function shownRowCount(hidden: readonly string[], section: PanelSection): number {
  const rows: readonly { id: string }[] = section.rows
  return rows.filter((row) => !hidden.includes(row.id)).length
}

/** What the panel's menu opens beside: a control, or a pointer position. */
export type PanelMenuAnchor = HTMLElement | { getBoundingClientRect: () => DOMRect }

/** A zero-size anchor at a pointer position, for a menu opened by a right-click. */
export function pointAnchor(x: number, y: number): PanelMenuAnchor {
  return { getBoundingClientRect: () => DOMRect.fromRect({ x, y, width: 0, height: 0 }) }
}
