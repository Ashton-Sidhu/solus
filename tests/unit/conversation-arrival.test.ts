import { expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../../packages/workspace-ui/src/components/conversation/lib/conversation-arrival.svelte.ts', import.meta.url), 'utf8')
const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(source
  .replace(/^import .*\n/gm, '')
  .replace(/\$state\((true|false)\)/g, '$1'))
  .replace('export class ConversationArrival', 'class ConversationArrival')

interface Arrival {
  pending: boolean
  open(): () => void
}

function fixture(savedPosition = false, frameHeights: () => Promise<boolean> = async () => false, rowData?: Promise<unknown>,
  history: { scrollHeight: number, hasOlder: () => boolean, loadOlder: () => Promise<void> } = { scrollHeight: 1000, hasOlder: () => false, loadOlder: async () => {} }) {
  const frames: FrameRequestCallback[] = []
  const scroll = { scrollTop: 0, scrollHeight: history.scrollHeight, clientHeight: 400 }
  const settled = Promise.withResolvers<void>()
  const restore = Promise.withResolvers<boolean>()
  const viewState = {
    position: savedPosition ? { key: 'saved-row', offset: 25 } : null,
    virtualizer: {
      restore: mock((_position: { key: string; offset: number }, _cancelled: () => boolean) => restore.promise),
      top: () => 300,
    },
  }
  const jump = mock(() => { scroll.scrollTop = 600 })
  const release = mock(() => {})
  const onSettled = mock(() => {})
  const settleScroll = mock((_element: typeof scroll, _target: () => number | undefined, _cancelled: () => boolean) => settled.promise)
  const waitForFrameHeightsIn = mock((_element: typeof scroll, _cancelled: () => boolean) => frameHeights())
  const create = new Function('tick', 'requestAnimationFrame', 'settleScroll', 'waitForFrameHeightsIn', 'options',
    `${executable}\nreturn new ConversationArrival(options);`)
  const arrival: Arrival = create(() => Promise.resolve(), (callback: FrameRequestCallback) => frames.push(callback), settleScroll, waitForFrameHeightsIn, {
    viewState, scroll: () => scroll, follower: () => ({ jump, release, atEnd: true }),
    openingSearch: () => false, pendingRowData: () => rowData,
    hasOlderHistory: history.hasOlder, loadOlderHistory: () => history.loadOlder().then(() => { scroll.scrollHeight += 600 }), onSettled,
  })
  return { arrival, viewState, jump, release, onSettled, settleScroll, settled, restore, waitForFrameHeightsIn,
    async frame() {
      await Promise.resolve()
      frames.shift()?.(0)
      await Promise.resolve()
    },
  }
}

test('real rows remain hidden until their initial reading position settles', async () => {
  const f = fixture()
  expect(f.arrival.pending).toBe(true)
  f.arrival.open()
  await f.frame()
  expect(f.jump).toHaveBeenCalledTimes(1)
  expect(f.arrival.pending).toBe(true)
  expect(f.onSettled).not.toHaveBeenCalled()
  f.settled.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(f.arrival.pending).toBe(false)
  expect(f.onSettled).toHaveBeenCalledTimes(1)
})

test('hiding a view before layout cancels its scroll writes', async () => {
  const f = fixture()
  const cancel = f.arrival.open()
  cancel()
  await f.frame()
  expect(f.jump).not.toHaveBeenCalled()
  expect(f.settleScroll).not.toHaveBeenCalled()
  expect(f.onSettled).not.toHaveBeenCalled()
})

test('a cancelled saved-position restore cannot reset the place or reveal a new arrival', async () => {
  const f = fixture(true)
  const cancel = f.arrival.open()
  await f.frame()
  expect(f.release).toHaveBeenCalledTimes(1)
  cancel()
  f.arrival.open()
  f.restore.resolve(false)
  await Promise.resolve()
  expect(f.viewState.virtualizer.restore.mock.calls[0][1]()).toBe(true)
  expect(f.viewState.position).toEqual({ key: 'saved-row', offset: 25 })
  expect(f.jump).not.toHaveBeenCalled()
  expect(f.arrival.pending).toBe(true)
  expect(f.onSettled).not.toHaveBeenCalled()
})

test('a saved row is restored instead of jumping to the end', async () => {
  const f = fixture(true)
  f.arrival.open()
  await f.frame()
  f.restore.resolve(true)
  await Promise.resolve()
  expect(f.settleScroll.mock.calls[0][1]()).toBe(325)
  expect(f.jump).not.toHaveBeenCalled()
  f.settled.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(f.arrival.pending).toBe(false)
})

test('completion of a cancelled settle cannot reveal a later opening', async () => {
  const f = fixture()
  const cancel = f.arrival.open()
  await f.frame()
  cancel()
  f.arrival.open()
  f.settled.resolve()
  await Promise.resolve()
  expect(f.arrival.pending).toBe(true)
  expect(f.onSettled).not.toHaveBeenCalled()
})

test('rows wait for an HTML frame in view to report its height, then settle again', async () => {
  // WHY: a frame with no remembered height grew after the rows showed and
  // moved them under the reader (layout shift 0.2–0.4 in the open benchmark).
  const heights = Promise.withResolvers<boolean>()
  const f = fixture(false, () => heights.promise)
  f.arrival.open()
  await f.frame()
  f.settled.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(f.waitForFrameHeightsIn).toHaveBeenCalledTimes(1)
  expect(f.arrival.pending).toBe(true)
  heights.resolve(true)
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  // The frames that reported moved the end, so the place is settled again.
  expect(f.settleScroll).toHaveBeenCalledTimes(2)
  expect(f.arrival.pending).toBe(false)
})

test('rows stay hidden until the turn snapshots read lands, then settle at the end', async () => {
  // WHY: each turn's changes card comes from a separate snapshot read. A card
  // that mounted after the rows showed grew its turn, and following the end
  // snapped the conversation down under the reader.
  const snapshots = Promise.withResolvers<void>()
  const f = fixture(false, async () => false, snapshots.promise)
  f.arrival.open()
  await f.frame()
  expect(f.jump).not.toHaveBeenCalled()
  expect(f.arrival.pending).toBe(true)
  snapshots.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(f.jump).toHaveBeenCalledTimes(1)
  f.settled.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(f.arrival.pending).toBe(false)
})

test('a snapshot read that never lands does not hold the conversation', async () => {
  // WHY: a slow or gone host must not keep the rows hidden; the cards then
  // move the rows when they land, which is the old behavior.
  const f = fixture(false, async () => false, new Promise<void>(() => {}))
  f.arrival.open()
  await f.frame()
  await new Promise((resolve) => setTimeout(resolve, 350))
  expect(f.jump).toHaveBeenCalledTimes(1)
  f.settled.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(f.arrival.pending).toBe(false)
})

test('a first page shorter than the view reads older history before the rows show', async () => {
  // WHY: a short first page showed at the top, read the older page after it
  // showed, and the view then snapped down to the end under the reader.
  const page = Promise.withResolvers<void>()
  let older = true
  const f = fixture(false, async () => false, undefined, {
    scrollHeight: 300, hasOlder: () => older, loadOlder: () => page.promise.then(() => { older = false }),
  })
  f.arrival.open()
  await f.frame()
  expect(f.jump).not.toHaveBeenCalled()
  expect(f.arrival.pending).toBe(true)
  page.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(f.jump).toHaveBeenCalledTimes(1)
  f.settled.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(f.arrival.pending).toBe(false)
})

test('an older page that fails to load does not hold the conversation', async () => {
  const loadOlder = mock(() => Promise.reject(new Error('gone')))
  const f = fixture(false, async () => false, undefined, { scrollHeight: 300, hasOlder: () => true, loadOlder })
  f.arrival.open()
  await f.frame()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(loadOlder).toHaveBeenCalledTimes(1)
  expect(f.jump).toHaveBeenCalledTimes(1)
  f.settled.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(f.arrival.pending).toBe(false)
})
