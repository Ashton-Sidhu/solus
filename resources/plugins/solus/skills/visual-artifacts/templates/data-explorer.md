# Data Explorer Template

Use this template when the playground is about data queries, APIs, pipelines, or structured configuration: SQL builders, API designers, regex builders, pipeline visuals, cron schedules.

## Layout

```
+-------------------+----------------------+
|                   |                      |
|  Controls         |  Formatted output    |
|  grouped by:      |  (syntax-highlighted |
|  • Source/tables  |   code, or a         |
|  • Columns/fields |   visual diagram)    |
|  • Filters        |                      |
|  • Grouping       |                      |
|  • Ordering       |                      |
|  • Limits         |                      |
+-------------------+----------------------+
|  Prompt output  [ Copy ]                 |
|  selectable <textarea> beneath the panels|
+------------------------------------------+
```

Use normal flow — no fixed positioning or nested scrolling. Outer body transparent.

## Control types by decision

| Decision | Control | Example |
|---|---|---|
| Select from available items | Clickable cards/chips | table names, columns, HTTP methods |
| Add filter/condition rows | Add button → row of dropdowns + input | WHERE column op value |
| Join type or aggregation | Dropdown per row | INNER/LEFT/RIGHT, COUNT/SUM/AVG |
| Limit/offset | Slider | result count 1–500 |
| Ordering | Dropdown + ASC/DESC toggle | order by column |
| On/off features | Toggle | show descriptions, include header |

## Preview rendering

Render syntax-highlighted output with `<span>` tags whose colours come from the Solus data palette (keywords, tables, strings each map to one palette slot, used consistently):

```js
function renderPreview() {
  const el = document.getElementById('preview');
  el.innerHTML = sql
    .replace(/\b(SELECT|FROM|WHERE|JOIN|ON|GROUP BY|ORDER BY|LIMIT)\b/g, '<span class="kw">$1</span>')
    .replace(/\b(users|orders|products)\b/g, '<span class="tbl">$1</span>')
    .replace(/'[^']*'/g, '<span class="str">$&</span>');
}
```

```css
.kw  { color: var(--solus-art-1); }  /* keywords — one consistent colour */
.tbl { color: var(--solus-art-4); }  /* identifiers */
.str { color: var(--solus-art-3); }  /* literals */
```

For pipeline-style playgrounds, render a horizontal or vertical flow using positioned divs with arrow connectors; colour each stage type consistently from the palette.

## Prompt output for data

Frame it as a specification of what to build, not the raw query itself:

> "Write a SQL query that joins orders to users on user_id, filters for orders after 2024-01-01 with total > $50, groups by user, and returns the top 10 users by order count."

Include the schema context (table names, column types) so the prompt is self-contained. Put it in a selectable readonly `<textarea>` with a copy button.

## Solus styling notes

- Surfaces `--solus-art-surface`/`--solus-art-raised`; hairlines `--solus-art-border`; text `--solus-text-*`; accent for primary actions.
- Monospace for code/values, system font for UI chrome. No raw grey, no gradients, 1px borders, sentence case, nothing below 11px, no emoji.
- Animate row add/remove and output updates subtly; honour `prefers-reduced-motion`.

## Example topics

- SQL query builder (tables, joins, filters, group by, order by, limit)
- API endpoint designer (routes, methods, request/response field builder)
- Data transformation pipeline (source → filter → map → aggregate → output)
- Regex builder (sample strings, match groups, live highlight)
- Cron schedule builder (visual timeline, interval, day toggles)
- GraphQL query builder (type selection, field picker, nested resolvers)

## Finish

Explain what you built in chat, then call `render_artifact` with the finished HTML as the last step.
