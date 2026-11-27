import { describe, expect, test } from 'bun:test'
import {
  MODAL_MIN_HEIGHT,
  MODAL_MIN_WIDTH,
  clampModalSize,
  hasTopHandles,
  maxModalSize,
  modalSizeStyle,
  readSavedModalSize,
  resizeModal,
  saveModalSize,
} from '@solus/workspace-ui/components/ui/modal-resize/modal-size'

const window = { width: 1400, height: 900 }
const start = { width: 800, height: 600 }

function memoryStorage() {
  const items = new Map<string, string>()
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  }
}

describe('modal size', () => {
  test('a centred modal grows on both sides, so the dragged edge stays under the pointer', () => {
    // WHY: the edge moves half the size change. A 1:1 rule leaves the pointer
    // behind the edge, and the drag feels broken.
    const max = maxModalSize(window, 150, 'center')
    expect(resizeModal(start, { x: 50, y: 40 }, 'bottom-right', 'center', max)).toEqual({ width: 900, height: 680 })
  })

  test('a left or top handle grows the modal when it moves away from the centre', () => {
    // WHY: every edge and corner drags. A left or top handle that used the
    // right or bottom sign would shrink the modal as the reader pulls it wider.
    const max = maxModalSize(window, 150, 'center')
    expect(resizeModal(start, { x: -50, y: -40 }, 'top-left', 'center', max)).toEqual({ width: 900, height: 680 })
    expect(resizeModal(start, { x: 50, y: -40 }, 'top-right', 'center', max)).toEqual({ width: 900, height: 680 })
    expect(resizeModal(start, { x: -50, y: 40 }, 'bottom-left', 'center', max)).toEqual({ width: 900, height: 680 })
    expect(resizeModal(start, { x: -30, y: 200 }, 'left', 'center', max)).toEqual({ width: 860, height: 600 })
    expect(resizeModal(start, { x: 200, y: -30 }, 'top', 'center', max)).toEqual({ width: 800, height: 660 })
  })

  test('a modal pinned near the top has no top handles, because its top cannot move', () => {
    expect(hasTopHandles('top')).toBe(false)
    expect(hasTopHandles('center')).toBe(true)
  })

  test('a modal pinned near the top grows downward only', () => {
    const max = maxModalSize(window, 100, 'top')
    expect(resizeModal(start, { x: 0, y: 40 }, 'bottom', 'top', max)).toEqual({ width: 800, height: 640 })
  })

  test('an edge handle changes one dimension only', () => {
    const max = maxModalSize(window, 150, 'center')
    expect(resizeModal(start, { x: 30, y: 200 }, 'right', 'center', max)).toEqual({ width: 860, height: 600 })
    expect(resizeModal(start, { x: 200, y: 30 }, 'bottom', 'center', max)).toEqual({ width: 800, height: 660 })
  })

  test('never grows past the window or shrinks below a usable floor', () => {
    const max = maxModalSize(window, 150, 'center')
    expect(resizeModal(start, { x: 5000, y: 5000 }, 'bottom-right', 'center', max)).toEqual({ width: 1368, height: 868 })
    expect(resizeModal(start, { x: -5000, y: -5000 }, 'bottom-right', 'center', max)).toEqual({
      width: MODAL_MIN_WIDTH,
      height: MODAL_MIN_HEIGHT,
    })
    // A top-pinned modal keeps a margin under its bottom edge.
    expect(maxModalSize(window, 100, 'top').height).toBe(784)
  })

  test('a window smaller than the floor still gets the floor', () => {
    expect(clampModalSize({ width: 500, height: 500 }, { width: 200, height: 100 })).toEqual({
      width: MODAL_MIN_WIDTH,
      height: MODAL_MIN_HEIGHT,
    })
  })

  test('the saved size stays inside a window that became smaller', () => {
    // WHY: the reader can resize on a large display and open the modal later
    // in a small window. The modal must not spill past the window.
    expect(modalSizeStyle({ width: 1200, height: 800 })).toContain('width: min(1200px, 100vw - 32px)')
    expect(modalSizeStyle({ width: 1200, height: 800 })).toContain('height: min(800px, 100dvh - 32px)')
    expect(modalSizeStyle(null)).toBeUndefined()
  })

  test('each kind of modal keeps its own size, and a reset forgets it', () => {
    const storage = memoryStorage()
    saveModalSize('settings', { width: 900, height: 700 }, storage)
    expect(readSavedModalSize('settings', storage)).toEqual({ width: 900, height: 700 })
    expect(readSavedModalSize('session-picker', storage)).toBeNull()

    saveModalSize('settings', null, storage)
    expect(readSavedModalSize('settings', storage)).toBeNull()
  })

  test('a damaged or blocked saved size opens the modal at its default', () => {
    const storage = memoryStorage()
    storage.setItem('solus.modal-size.settings', 'wide')
    expect(readSavedModalSize('settings', storage)).toBeNull()
    storage.setItem('solus.modal-size.settings', '10x10')
    expect(readSavedModalSize('settings', storage)).toBeNull()

    const blocked = {
      getItem: () => {
        throw new Error('blocked')
      },
    }
    expect(readSavedModalSize('settings', blocked)).toBeNull()
  })
})
