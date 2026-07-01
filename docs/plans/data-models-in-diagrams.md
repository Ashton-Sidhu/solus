# Implementation Plan — Data Models in Architecture Diagrams

Extend the existing `diagram` work type so a node can represent a **data-model entity**
(a table with typed fields/keys) and an edge can carry **relationship cardinality**.
A pure ER diagram is just a diagram where every node is an entity; entities can also be
mixed with service nodes in an architecture/data-flow diagram.

This plan is sequenced so each milestone is independently shippable and testable.
M1 is usable end-to-end via the agent; M2–M3 layer on visual polish and manual editing.

## Resolved design decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Entity detection | **Presence of `fields`** — no discriminator |
| 2 | Field visibility | **Always visible** (like badges), not behind expand |
| 3 | Relationship source of truth | **Edges draw lines + carry cardinality; `ref` is a complementary column annotation** (no synthesis/dedup) |
| 4 | Cardinality UI | **Crow's-foot endpoint markers** (per-end) |
| 5 | Cardinality vocabulary | **`1-1` / `1-n` / `n-1` / `n-n`**, source→target ordered, no optionality circles |
| 6 | Mermaid export | **Leave lossy** (flowchart rectangles); PNG/SVG/JSON carry full fidelity |
| 7 | Manual editing | **Full parity** — Fields editor in node drawer + cardinality selector in edge drawer |
| 8 | ERD entry point | **None** — one `diagram` type; authoring guidance covers pure + mixed |
| 9 | Field-level anchoring | **Deferred** to a later phase |

Resolved by existing idiom: field validation mirrors `actions` filtering in `normalizeNodes`;
dangling `ref` renders verbatim; `group: true` beats `fields`; entities default to a table glyph icon.

## Core model (`src/shared/diagram-types.ts`)

```ts
interface DiagramField {
  name: string
  type?: string                      // "uuid", "varchar(255)"
  key?: 'pk' | 'fk' | 'unique'
  nullable?: boolean
  ref?: string                       // "users.id" — documentary FK annotation
}

interface DiagramNode {
  // ...existing, unchanged...
  fields?: DiagramField[]            // presence => render as an entity
}

interface DiagramEdge {
  // ...existing, unchanged...
  cardinality?: '1-1' | '1-n' | 'n-1' | 'n-n'   // source -> target ordered
}
```

---

## M0 · Data model & validation

**Goal:** the type contract exists and is safe to parse.

**`src/shared/diagram-types.ts`**
- Add `DiagramField` and the two new optional fields above.
- Add a `VALID_FIELD_KEY` set (mirrors `VALID_ACTION_DO`).
- In `normalizeNodes`: when `node.fields`, filter to rows with a non-empty `name`, clamp/strip
  invalid `key`, and drop `fields` entirely if empty afterward. If `node.group`, delete `fields`
  (group wins — groups are pure containers).
- Edge `cardinality`: edges aren't normalized today — add a minimal guard in `parseDiagram`
  that strips any `cardinality` outside the four-value set.

**Acceptance:** unit tests parse/normalize fields & cardinality; malformed rows dropped;
group + fields → fields removed.

---

## M1 · Entity rendering + layout

**Goal:** an agent-authored entity renders correctly and lays out without overlap.

**`src/renderer/components/diagram/nodes/DiagramNode.svelte`**
- When `data.fields?.length`, render an always-visible field table under the header: each row =
  key glyph (PK/FK/unique) · `name` · muted `type`, with a subtle `→ ref` hint on FK rows.
- Default icon → table glyph when `icon` absent and `fields` present.
- Tailwind for row styling, theme tokens for light/dark, tabular alignment for types.

**`src/shared/diagram-layout.ts`**
- `estimateNodeSize`: add `fields.length * ROW_H` (+ small table-header pad); widen the
  entity max-width clamp (entities carry `name : type`, wider than service cards).

**`src/renderer/components/diagram/diagram-icons.ts`** — register a `table`/`entity` default glyph.

**Acceptance:** e2e — an entity diagram renders rows, no overlap; tall entities get correct height.

---

## M2 · Relationships: crow's-foot cardinality

**Goal:** `cardinality` draws per-end crow's-foot markers.

**Approach (decided):** draw the glyphs directly in the custom edge rather than registering
xyflow `<marker>` defs. `DiagramEdge.svelte` already computes endpoint coords
(`ends.sx/sy`, `sPos`) and floats endpoints, so render small oriented SVG shapes at each end
inside the edge `<g>`, oriented by `sPos`/`tPos`. Avoids marker-id plumbing and matches edge
color directly.

**`src/renderer/components/diagram/edges/DiagramEdge.svelte`**
- Read `data.cardinality`; split into `sourceEnd`/`targetEnd` ∈ `one | many`.
- Render a "one" bar or "many" crow's-foot at each end, rotated to the endpoint side.
  Stroke from edge color/accent.

**`src/renderer/components/diagram/lib/flow-builders.ts`**
- Pass `cardinality` into edge `data`. On entity-entity edges with cardinality, suppress the
  default `ArrowClosed` marker (crow's-foot replaces it).

**Acceptance:** unit test for cardinality → per-end mapping; e2e snapshot of a 1-n relationship.

---

## M3 · Manual editing (full parity)

**Goal:** entities & cardinality editable in the drawers, keyboard-navigable.

**`DiagramDetailsDrawer.svelte`** — Fields editor cloning the Metrics row pattern: each row has
`name`, `type`, a `key` dropdown (none/pk/fk/unique), a `nullable` toggle, and `ref`; add/remove
row; commit via `onUpdateNode({ fields })`. Local `$state` mirror resynced on node switch (same
idiom as metrics). Enter-to-add, keyboard-reachable.

**`DiagramEdgeDrawer.svelte`** — add a `CARDINALITY` option group (mirrors `ARROWS`) +
`onUpdateCardinality` prop; extend the props `Pick<>` with `'cardinality'`; small
endpoint-preview SVGs.

**`DiagramShell.svelte`** — wire `onUpdateCardinality` and ensure `fields` round-trips through
the node update path.

**Acceptance:** e2e — add a field via drawer, set a FK + cardinality, persists & re-renders.

---

## M4 · Authoring guidance

**`src/main/folio/work-tools.ts`** — extend `DIAGRAM_GUIDANCE`: an entity example (node with
`fields`), document `fields`/`key`/`ref` and edge `cardinality`, and the rule "for a database/ER
diagram, make every node an entity; mix entities with service nodes for data-flow diagrams."

---

## M5 · Tests & verification

- **Unit:** `diagram-types.test.ts` (field/cardinality parse + normalize, group precedence);
  cardinality mapping near `diagram-edge-anchor.test.ts`; `diagram-layout.test.ts` (entity height).
- **E2e:** extend `diagram-creation` / `diagram-editing` specs for entity render + field editing +
  cardinality.
- **Manual:** run the app, ask the agent for an ER diagram and a mixed diagram; verify
  render/edit/export (PNG/SVG/JSON full fidelity; Mermaid lossy as designed).

---

## Out of scope (later phases)

- Field-level FK→PK edge anchoring (per-field xyflow handles + layout/hit-testing).
- `erDiagram` Mermaid export for pure ERDs.
- Optionality (zero-or-one / zero-or-many) crow's-foot variants.
- Dedicated "New ER Diagram" template/button.

## Suggested commit boundaries

Four reviewable PRs: **M0+M1** (data+render) · **M2** (cardinality) · **M3** (editing) ·
**M4+M5** (guidance+tests).
