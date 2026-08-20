import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const readSessionSource = (file: string) =>
  readFileSync(
    join(import.meta.dir, '../../packages/workspace-ui/src/components/session', file),
    'utf8',
  )

describe('session sidebar layout', () => {
  test('keeps the primary navigation compact and on the task-list inset', () => {
    // WHY: the sidebar is a narrow working rail. Its navigation must not use
    // more vertical space or left padding than the task list below it.
    const source = readSessionSource('SessionSidebar.svelte')
    expect(source.match(/size="sm"/g)).toHaveLength(6)
    expect(source.match(/h-7 w-full[\s\S]*?pl-\[0\.125rem\]/g)).toHaveLength(6)
  })

  test('does not indent open task titles with disclosure chrome', () => {
    // WHY: subtask counts and chevrons made parent titles start farther right
    // than ordinary tasks. Expansion remains available from the row and keys.
    const source = readSessionSource('TaskRow.svelte')
    expect(source).not.toContain('CaretDownIcon')
    expect(source).not.toContain('CaretRightIcon')
    expect(source).not.toContain('>{sessions.length}</span')
    expect(source).toContain('{#if isCompleted}')
  })

  test('slightly mutes task and session titles outside the selected path', () => {
    // WHY: the active task/session path must scan first without making the
    // surrounding navigation look disabled or difficult to read.
    const taskSource = readSessionSource('TaskRow.svelte')
    const sessionSource = readSessionSource('TaskSessionRow.svelte')
    const mutedTitle =
      'text-[color-mix(in_oklch,var(--solus-text-secondary)_75%,transparent)]'

    expect(taskSource).toContain(mutedTitle)
    expect(sessionSource).toContain(mutedTitle)
    expect(taskSource).toContain("titleLeads\n ? 'text-foreground'")
    expect(sessionSource).toContain("titleLeads\n            ? 'text-foreground'")
  })

  test('extends hover plates while keeping child connectors on the task spine', () => {
    // WHY: negative margins add breathing room, but the child connector must
    // compensate for that inset or its selected elbow shifts left of the tree.
    // Child content sits one small step beyond the elbow to clarify hierarchy.
    const taskSource = readSessionSource('TaskRow.svelte')
    const sessionSource = readSessionSource('TaskSessionRow.svelte')
    expect(taskSource).toContain('-mx-2 flex cursor-pointer')
    expect(taskSource).toContain('pr-2 pl-[0.625rem]')
    expect(sessionSource).toContain('-mx-2 flex h-[2.875rem]')
    expect(sessionSource).toContain('pr-2 pl-11')
    expect(sessionSource).toContain('top-0 left-[1.125rem]')
    expect(sessionSource).toContain(
      'top-[0.875rem] left-[1.125rem] w-[1.125rem]',
    )
  })

  test('aligns shelf headers with the task row box', () => {
    // WHY: shelf headers and task rows share one visual column. Their labels
    // and right-side controls must not shift when the shelf opens.
    const source = readSessionSource('SessionSidebar.svelte')
    expect(
      source.match(
        /-mx-2 flex h-7 w-\[calc\(100%\+1rem\)\][\s\S]*?pl-\[0\.625rem\]/g,
      ),
    ).toHaveLength(2)
  })

  test('keeps task metadata on one right edge without a PR chevron', () => {
    // WHY: elapsed times, status marks, and PR chips form one margin. Each must
    // claim the remaining row space so its outside edge stays aligned while
    // titles and project names change length. The PR chip needs no second
    // navigation mark because the chip itself is already an explicit action.
    const taskSource = readSessionSource('TaskRow.svelte')
    const prChipSource = readSessionSource('PrChip.svelte')

    expect(taskSource).toContain(
      'ml-auto flex shrink-0 items-center gap-[0.5625rem]',
    )
    expect(taskSource).toContain('ml-auto flex shrink-0 items-center')
    expect(prChipSource).not.toContain('CaretRightIcon')
  })

  test('keeps sidebar times at the old desktop size and shrinks them on laptops', () => {
    // WHY: timestamps are supporting metadata. They must remain 12px on a large
    // desktop instead of growing with row labels, while the responsive shelf
    // rung reduces them to 10px on a laptop display.
    const taskSource = readSessionSource('TaskRow.svelte')
    const sessionSource = readSessionSource('TaskSessionRow.svelte')

    expect(taskSource.match(/text-chrome-shelf[^\n]*tabular-nums/g)).toHaveLength(3)
    expect(sessionSource.match(/text-chrome-shelf[^\n]*tabular-nums/g)).toHaveLength(1)
    expect(taskSource).not.toMatch(/text-workspace-chrome[^\n]*tabular-nums/)
    expect(sessionSource).not.toMatch(/text-workspace-chrome[^\n]*tabular-nums/)
  })

  test('gives two-line task rows a clear title-to-metadata gap', () => {
    // WHY: title and project metadata are separate scan targets. A 10px gap
    // and a 56px row keep them distinct without crowding the row edges.
    const source = readSessionSource('TaskRow.svelte')
    expect(source).toContain(
      'class="mt-[0.625rem] flex h-5 min-w-0 max-w-full items-center',
    )
    expect(source).toContain("{showsBottomRow ? 'h-[3.5rem]' : 'h-[2.125rem]'}")
  })

  test('keeps metadata the same height with or without a PR chip', () => {
    // WHY: the PR chip fits within a 20px metadata line at every display rung.
    // Reserving that line prevents task content from shifting when one appears.
    const source = readSessionSource('TaskRow.svelte')
    expect(source).toContain(
      'mt-[0.625rem] flex h-5 min-w-0 max-w-full items-center',
    )
  })

  test('renders PR metadata as plain project-sized text on desktop and laptop', () => {
    // WHY: the PR belongs on the same metadata line as the project. It must use
    // the same text size without a chip plate, while its icon can still compact
    // on fine-pointer laptop displays.
    const source = readSessionSource('PrChip.svelte')
    const desktopSource = readSessionSource('TaskRow.svelte')

    expect(source).toContain('items-center gap-[0.21875rem] text-xs')
    expect(source).toContain('<span class="tabular-nums"')
    expect(source).not.toContain('style:--pr-bg')
    expect(source).not.toContain('hover:bg-')
    expect(source).not.toContain('hover:shadow-')
    expect(source).toContain('pointer-fine:[.is-laptop-display_&]:gap-0.5')
    expect(source.match(/pointer-fine:\[\.is-laptop-display_&\]:size-3/g)).toHaveLength(2)
    expect(source).not.toMatch(/\[\.is-laptop-display_&\]:text-/)
    expect(desktopSource).toContain('<PrChip chip={prChip} onOpen={onOpenPr} />')
  })

  test('starts the task search glyph on the sidebar icon column', () => {
    // WHY: the search field sits between the navigation and the task list, so
    // its glyph must share their 16px inset. Any other offset reads as a
    // misaligned row the moment the sidebar is scanned top to bottom.
    const source = readSessionSource('SessionSidebar.svelte')
    // 14px section padding + 2px = the 16px column the nav icons use.
    expect(source).toContain('absolute top-1/2 left-0.5 -translate-y-1/2')
    // That glyph plus the 9px navigation gap places the text at 25px.
    expect(source).toContain('pr-8 pl-[1.5625rem]')
  })

  test('leads the task list with drafts and separates them from open tasks', () => {
    // WHY: a heading that appears only while a draft exists is a standing row
    // the column cannot afford, and labelling one group and not the other reads
    // as if it labels both. Drafts lead the same scroller as the tasks, told
    // apart by their own row and a quiet divider below the group.
    const source = readSessionSource('SessionSidebar.svelte')
    expect(source).toContain(
      'class="mb-2 flex flex-col gap-[0.1875rem] border-b border-sidebar-border/50 pb-2"\n        role="listbox"\n        aria-label="Drafts"',
    )
    // One action bar in the whole column, and it belongs to the tasks.
    expect(source.match(/<TaskActionBar/g)).toHaveLength(1)
    // No nested scroller: the drafts group sits inside the task scroll area.
    expect(source).not.toContain('flex max-h-[10.5rem] flex-shrink-0 flex-col')
  })

  test('spaces the task list below search and divides shelf labels from counts', () => {
    // WHY: the first row needs breathing room below the search controls, while
    // shelf counts need a clear visual relationship without reading as labels.
    const source = readSessionSource('SessionSidebar.svelte')
    expect(source).toContain(
      'class="@container min-h-0 flex-1 overflow-y-auto px-3.5 pt-2 pb-3.5',
    )
    expect(source.match(/class="h-px min-w-4 flex-1 bg-sidebar-border\/50"/g)).toHaveLength(2)
    expect(source).toContain('>{searchedSnoozedTasks.length}</span')
    expect(source).toContain('>{searchedCompletedTasks.length}</span')
  })

  test('leads compact draft metadata with its square pen and project identity', () => {
    // WHY: a draft becomes an open task when sent, so its title and project
    // identity must stay together, with less space than the open-task rows.
    const source = readSessionSource('DraftRow.svelte')
    expect(source).toContain('h-[3.5rem]')
    expect(source).toContain('class="mt-[0.375rem] flex h-5')
    expect(source).toContain('<SquarePenIcon size={14} />')
    expect(source).toContain('projectRoot={row.projectKey}')
    expect(source.indexOf('<SquarePenIcon size={14} />')).toBeLessThan(
      source.indexOf('projectRoot={row.projectKey}'),
    )
    expect(source).toContain('class="size-4 @max-[15rem]:size-[0.875rem]"')
    expect(source).toContain('>{row.projectLabel}</span')
  })

  test('expands matching completed tasks while search is active', () => {
    // WHY: a matching completed task is not a usable search result if the
    // Completed shelf stays collapsed. The manual shelf preference remains
    // separate so clearing the search restores the user's prior state.
    const source = readSessionSource('SessionSidebar.svelte')
    expect(source).toContain(
      'completedShelfOpen ||\n      (taskQuery.trim().length > 0 && searchedCompletedTasks.length > 0)',
    )
    expect(source).toContain('aria-expanded={isCompletedShelfExpanded}')
    expect(source).toContain('{#if isCompletedShelfExpanded}')
  })

  test('reveals a snoozed or completed task selected from the session picker', () => {
    // WHY: selecting an already-mounted session does not restore a new row, so
    // the picker must explicitly open the shelf that already contains it.
    const pickerSource = readSessionSource('SessionPicker.svelte')
    expect(pickerSource).toContain('void revealSidebarTask(entry.tabId)')
    expect(pickerSource).toContain('void resumed.then(revealSidebarTask)')
    expect(pickerSource).toContain(
      'new CustomEvent("solus:expand-sidebar-task", { detail: task.id })',
    )

    const sidebarSource = readSessionSource('SessionSidebar.svelte')
    expect(sidebarSource).toContain('completedShelfOpen = true')
    expect(sidebarSource).toContain('snoozedShelfOpen = true')
  })

  test('keeps project filtering behind one compact filter action', () => {
    // WHY: an always-visible project selector looked like a task row and used
    // scarce width even when no scope was active.
    const source = readSessionSource('TaskActionBar.svelte')
    expect(source).toContain('FunnelIcon')
    expect(source).toContain('aria-haspopup="menu"')
    expect(source).toContain('ml-auto flex shrink-0 items-center gap-1')
    expect(source).not.toContain('menuOpen || scopedProject')
    expect(source).toContain('text-primary')
    expect(source).not.toContain('All projects')
  })

})
