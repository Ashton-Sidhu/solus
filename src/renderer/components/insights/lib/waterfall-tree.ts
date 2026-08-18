import { labelForKind } from './span-palette'
import { barExtent, unionLength, type Interval, type WaterfallRow } from './waterfall'

// The waterfall's rows, folded into the groups a reader actually asks about.
//
// A turn's span list is flat and long: a dozen tool calls, a thinking span per
// segment, a response stream per segment. Drawn one row per span it is a wall
// that answers no question. Here a *run* of consecutive siblings of one kind
// becomes a single lane — every member still drawn on it, on the same time
// axis, so the shape of the turn survives the fold — and the lane opens when
// the reader wants the individual spans.
//
// The fold is by run rather than by kind because the waterfall is a picture of
// sequence. A turn that thought, called three tools, thought again and called
// five more reads as four rows in that order; pooling by kind would collapse it
// into "thinking, then tools" and lose the alternation the reader came for.
//
// Pure and non-reactive.

/** A run forms a lane only from this many. A lone span is worth less as a
 *  group header than as itself. */
export const GROUP_FROM = 2

export interface WaterfallGroup {
  /** Stable across renders: parent span, kind, and the run's place in the
   *  parent's sequence. */
  id: string
  spanKind: string
  label: string
  color: string
  /** Direct members, the spans the lane draws. */
  memberCount: number
  /** Members plus everything nested under them — what the fold hides. */
  spanCount: number
  /** Distinct member names, most frequent first: "Bash ×4, Read ×2". Empty
   *  when every member shares one name, which the label already says. */
  detail: string
  /** Union of member intervals. Overlapping tools are counted once. */
  totalMs: number
  share: number
  startOffsetMs: number
  errorCount: number
}

export interface SpanNode {
  type: 'span'
  id: string
  row: WaterfallRow
  children: WaterfallNode[]
}

export interface GroupNode {
  type: 'group'
  id: string
  group: WaterfallGroup
  members: SpanNode[]
}

export type WaterfallNode = SpanNode | GroupNode

/** Rebuilds the parent/child tree from the depth-first rows and their depth.
 *  The rows already resolved dropped parents onto the root, so this reads the
 *  tree the chart is meant to show rather than the raw parent ids. */
function treeFromRows(rows: WaterfallRow[]): RawNode[] {
  const roots: RawNode[] = []
  const stack: RawNode[] = []
  for (const row of rows) {
    const node: RawNode = { row, children: [] }
    while (stack.length > row.depth) stack.pop()
    const parent = stack[row.depth - 1]
    if (parent) parent.children.push(node)
    else roots.push(node)
    stack[row.depth] = node
  }
  return roots
}

interface RawNode {
  row: WaterfallRow
  children: RawNode[]
}

function countSpans(node: RawNode): number {
  return 1 + node.children.reduce((total, child) => total + countSpans(child), 0)
}

function countErrors(node: RawNode): number {
  return (
    (node.row.status === 'error' ? 1 : 0) +
    node.children.reduce((total, child) => total + countErrors(child), 0)
  )
}

function intervalOfRow(row: WaterfallRow): Interval {
  return { from: row.startOffsetMs, to: row.startOffsetMs + (row.durationMs ?? 0) }
}

/** The names in a lane, most frequent first. Two at most: the label column is
 *  narrow, and the point is a hint at what is inside, not a manifest. */
function memberDetail(members: RawNode[]): string {
  const counts = new Map<string, number>()
  for (const member of members) {
    const name = member.row.span?.name ?? member.row.kind
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  if (counts.size < 2) return ''
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const shown = ordered.slice(0, 2).map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
  const rest = ordered.length - shown.length
  return rest > 0 ? `${shown.join(', ')}, +${rest}` : shown.join(', ')
}

/**
 * Consecutive siblings of one kind, in the order the turn ran them.
 *
 * A run, not every span of that kind under the parent: the waterfall exists to
 * show sequence, so thinking → three tools → thinking → five tools stays four
 * rows in that order. Pooling both thinking spans into one lane would read as
 * "the turn thought, then called tools", which is not what happened.
 */
function runsOfKind(children: RawNode[]): RawNode[][] {
  const runs: RawNode[][] = []
  for (const child of children) {
    const current = runs[runs.length - 1]
    if (current && current[0].row.kind === child.row.kind) current.push(child)
    else runs.push([child])
  }
  return runs
}

function groupChildren(parentSpanId: string, children: RawNode[], totalMs: number): WaterfallNode[] {
  const nodes: WaterfallNode[] = []
  let position = 0
  for (const members of runsOfKind(children)) {
    const spanNodes = members.map((member) => toSpanNode(member, totalMs))
    position += 1
    if (members.length < GROUP_FROM) {
      nodes.push(...spanNodes)
      continue
    }
    const kind = members[0].row.kind
    // The run's place in the sequence keeps the id unique when a parent runs
    // the same kind more than once.
    const id = `${parentSpanId}::${kind}::${position}`
    const groupMs = unionLength(members.map((member) => intervalOfRow(member.row)))
    nodes.push({
      type: 'group',
      id,
      group: {
        id,
        spanKind: kind,
        label: labelForKind(kind),
        color: members[0].row.color,
        memberCount: members.length,
        spanCount: members.reduce((total, member) => total + countSpans(member), 0),
        detail: memberDetail(members),
        totalMs: groupMs,
        share: groupMs / totalMs,
        startOffsetMs: members[0].row.startOffsetMs,
        errorCount: members.reduce((total, member) => total + countErrors(member), 0),
      },
      members: spanNodes,
    })
  }
  return nodes
}

function toSpanNode(node: RawNode, totalMs: number): SpanNode {
  return {
    type: 'span',
    id: node.row.spanId,
    row: node.row,
    children: groupChildren(node.row.spanId, node.children, totalMs),
  }
}

/** The whole trace as nodes: the turn root, with every level of its children
 *  folded into per-kind lanes. */
export function buildWaterfallTree(rows: WaterfallRow[], totalMs: number): WaterfallNode[] {
  return treeFromRows(rows).map((node) => toSpanNode(node, Math.max(1, totalMs)))
}

export interface SpanLine {
  type: 'span'
  id: string
  depth: number
  row: WaterfallRow
  expandable: boolean
  expanded: boolean
  /** Spans folded under this one, all levels. Zero when it has no children. */
  hiddenCount: number
}

export interface GroupLine {
  type: 'group'
  id: string
  depth: number
  group: WaterfallGroup
  expanded: boolean
}

export type WaterfallLine = SpanLine | GroupLine

function hiddenUnder(nodes: WaterfallNode[]): number {
  return nodes.reduce(
    (total, node) => total + (node.type === 'group' ? node.group.spanCount : 1 + hiddenUnder(node.children)),
    0,
  )
}

/** The visible rows, given which lanes and spans the reader has opened. An
 *  expanded group keeps its header line so the fold stays reversible.
 *
 *  The turn root is the trace, not a fold inside it: it is always open, and it
 *  offers no disclosure of its own. */
export function flattenTree(
  nodes: WaterfallNode[],
  expanded: ReadonlySet<string>,
  depth = 0,
): WaterfallLine[] {
  const lines: WaterfallLine[] = []
  for (const node of nodes) {
    const isRoot = depth === 0 && node.type === 'span'
    const isOpen = isRoot || expanded.has(node.id)
    if (node.type === 'group') {
      lines.push({ type: 'group', id: node.id, depth, group: node.group, expanded: isOpen })
      if (isOpen) lines.push(...flattenTree(node.members, expanded, depth + 1))
      continue
    }
    lines.push({
      type: 'span',
      id: node.id,
      depth,
      row: node.row,
      expandable: !isRoot && node.children.length > 0,
      expanded: isOpen,
      hiddenCount: hiddenUnder(node.children),
    })
    if (isOpen) lines.push(...flattenTree(node.children, expanded, depth + 1))
  }
  return lines
}

/** Every id that can open. What "Expand all" sets. The turn root is not one:
 *  it is always open. */
export function expandableIds(nodes: WaterfallNode[]): string[] {
  const ids: string[] = []
  const walk = (level: WaterfallNode[], depth: number): void => {
    for (const node of level) {
      if (node.type === 'group') {
        ids.push(node.id)
        walk(node.members, depth + 1)
      } else if (node.children.length > 0) {
        if (depth > 0) ids.push(node.id)
        walk(node.children, depth + 1)
      }
    }
  }
  walk(nodes, 0)
  return ids
}

/** Ids to open so one span is on screen — how a deep link lands inside a fold.
 *  Empty when the span is not in this trace. */
export function pathToSpan(nodes: WaterfallNode[], spanId: string): string[] {
  const walk = (level: WaterfallNode[], ancestors: string[], depth: number): string[] | null => {
    for (const node of level) {
      if (node.type === 'group') {
        const found = walk(node.members, [...ancestors, node.id], depth + 1)
        if (found) return found
        continue
      }
      if (node.row.spanId === spanId) return ancestors
      // The root is always open, so it never belongs on the path.
      const found = walk(node.children, depth > 0 ? [...ancestors, node.id] : ancestors, depth + 1)
      if (found) return found
    }
    return null
  }
  return walk(nodes, [], 0) ?? []
}

export interface WaterfallBar {
  /** Unique per bar; the chart keys each layer's data on it. */
  id: string
  /** The band the bar sits in — a line id, not a span id. */
  lineId: string
  spanId: string
  label: string
  color: string
  durationMs: number | null
  from: number
  to: number
  /** An open group's lane still draws its members, quietly: the lane is a
   *  summary of the rows now listed under it, not a second copy of them. */
  faded: boolean
}

/** A span's colour on the plot. Kind decides the hue, except for a failure,
 *  which wears the reserved status colour so it reads at a glance from a
 *  folded lane. */
function barColor(row: WaterfallRow): string {
  return row.status === 'error' ? 'var(--failure)' : row.color
}

function barOf(row: WaterfallRow, lineId: string, totalMs: number, faded: boolean): WaterfallBar {
  const [from, to] = barExtent(row, totalMs)
  return {
    id: `${lineId}:${row.spanId}`,
    lineId,
    spanId: row.spanId,
    label: row.label,
    color: barColor(row),
    durationMs: row.durationMs,
    from,
    to,
    faded,
  }
}

/**
 * Every bar the plot draws, for the lines currently visible.
 *
 * A group lane draws one bar per member rather than a merged block: members
 * overlap in the same hue anyway, and one bar per span keeps every span
 * hoverable and clickable without opening the lane first.
 */
export function barsForLines(
  lines: WaterfallLine[],
  nodes: WaterfallNode[],
  totalMs: number,
): WaterfallBar[] {
  const groupsById = new Map<string, GroupNode>()
  const collect = (level: WaterfallNode[]): void => {
    for (const node of level) {
      if (node.type === 'group') {
        groupsById.set(node.id, node)
        collect(node.members)
      } else collect(node.children)
    }
  }
  collect(nodes)

  const bars: WaterfallBar[] = []
  for (const line of lines) {
    if (line.type === 'span') {
      // The turn root is the track the rest of the trace sits inside, so it is
      // drawn as quietly as an opened lane rather than as another span.
      bars.push(barOf(line.row, line.id, totalMs, line.depth === 0))
      continue
    }
    const node = groupsById.get(line.id)
    if (!node) continue
    for (const member of node.members) {
      bars.push(barOf(member.row, line.id, totalMs, line.expanded))
    }
  }
  return bars
}
