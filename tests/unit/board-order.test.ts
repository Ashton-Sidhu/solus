import { describe, expect, it } from 'bun:test'
import type { Task } from '@solus/contracts/task-types'
import { orderColumn } from '@solus/workspace-ui/components/tasks/lib/board-order'

/**
 * Manual card order on the kanban board.
 *
 * The rule worth guarding is that dragging one card is a statement about *that*
 * card: it must not silently freeze the rest of the column against the page's
 * sort. That falls out of `sort` being stable, which is exactly the kind of
 * load-bearing language guarantee a test should pin rather than a comment.
 */
const task = (id: string): Task =>
  ({ id, title: id, status: 'todo', kind: 'task', providerId: 'local', body: '', labels: [], url: null, updatedAt: 0 }) as Task

const ids = (tasks: Task[]) => tasks.map((t) => t.id)

describe('orderColumn', () => {
  it('leaves an untouched column entirely to the page sort', () => {
    expect(ids(orderColumn([task('a'), task('b'), task('c')], {}))).toEqual(['a', 'b', 'c'])
  })

  it('leads with the cards that were placed, and keeps the rest in sorted order', () => {
    // Only 'c' was ever dragged. 'a', 'b' and 'd' never made a claim about where
    // they sit, so they stay in whatever order the page's sort hands over.
    expect(ids(orderColumn([task('a'), task('b'), task('c'), task('d')], { c: 0 }))).toEqual([
      'c',
      'a',
      'b',
      'd',
    ])
  })

  it('ignores ranks for cards this column no longer holds', () => {
    // 'gone' moved to another column or was deleted. Its stale rank must not
    // open a hole or disturb the survivors.
    expect(ids(orderColumn([task('a'), task('b')], { gone: 0, b: 1 }))).toEqual(['b', 'a'])
  })

  it('does not mutate the array it is given', () => {
    // The caller's array is a `$derived` column; sorting it in place would
    // reorder the value other readers see without invalidating them.
    const column = [task('a'), task('b')]
    orderColumn(column, { b: 0 })
    expect(ids(column)).toEqual(['a', 'b'])
  })
})
