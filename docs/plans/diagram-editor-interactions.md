# Diagram editing and export

The editor, reading preview, and image stage share one route calculation per canvas.
Parallel connections use separate floating connection points. Orthogonal routes check
node bounds and existing connections. Labels wrap at 240 canvas pixels and use measured
bounds to avoid nodes, connections, and other automatic labels. Dense diagrams can place
labels outside the graph with a dotted line to their connection. Explicit straight routes,
pinned handles, manual bends, and manual label positions remain author choices.

Drag a connection label to move its text without changing the route. When the label has
keyboard focus, arrow keys move it by 10 canvas pixels; Shift moves it by 1 pixel. Click
or press Enter to edit the text. The connection inspector can reset the label to automatic
placement. `labelOffset` is stored relative to the route anchor. Manual bend movement
stores `bendAxis` with `bendOffset`, so taking control of an automatic detour does not
change its axis. These values use the existing diagram document transport and save path.

The canvas toolbar exposes Undo, Redo, Duplicate, Search, and an alignment menu. The menu
includes Select all nodes, so touch users can arrange the diagram without a keyboard. It
scrolls within a 320 px height cap, reduced when the available viewport space is smaller. It
aligns two or more selected nodes, matches their widths or heights, or distributes three
or more nodes with equal empty gaps. Matching sizes uses the largest selected dimension.
A selected group carries its children; a selected child does not move twice. Alignment
uses absolute positions across groups. Each command is one undo step. Explicit auto-layout
uses measured node sizes and resets pinned handles and bends. Independent label offsets
remain until the author resets them.

During a node drag, temporary dashed guides show matching edges and centers within one
screen pixel. The guides use absolute positions for nodes inside groups and the outer
bounds of a moving selection. Hidden nodes, the moving group's children, and the moving
node's ancestors do not act as references. The guides clear when alignment is lost or
the drag ends, and do not appear in exports. They give visual feedback without changing
the node's position. Touch users see the same guides with Move nodes enabled.

Undo and redo keep up to 100 full-document snapshots in the mounted editor. Entering or
leaving a detail diagram does not clear history. Undo returns to the view where the edit
occurred. History is not persisted across closing the editor. Saving retains its visible
failure and retry state; an older save response cannot clear a newer pending edit.

Search matches node names, subtitles, entity fields, and connection labels. Typing marks
matches without moving the canvas. Enter and Shift+Enter, or the next and previous buttons,
cycle through results. Navigation keeps the current zoom and reveals collapsed ancestors.
Escape closes search and returns focus to the canvas. Search covers the current detail
view, not unopened detail diagrams.

PNG, SVG, and Copy Image include visible node, route, and label bounds. Export waits for
fonts and measurement, mounts virtualized elements, hides editing controls, and removes
selection and search emphasis without changing saved state. Page exports set typography
on the diagram shell, independently of the app's display size. Raster resolution scales
the whole drawing uniformly.

All controls use the shared workspace component on desktop, web, and mobile. The toolbar
wraps in narrow panes. Touch can move labels directly and use explicit recovery and search
buttons. These changes do not depend on the agent provider or a local filesystem.

Verification uses geometry fixtures for parallel and reverse edges, long labels in all
four directions, manual bends, grouped alignment, equal spacing, serialization, export
bounds, search, and full-document history. Routing minimizes intersections; it is not a
general graph-planarity solver. Intentional manual positions can still overlap.
