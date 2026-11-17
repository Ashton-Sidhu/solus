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

function fixture(savedPosition = false) {
  const frames: FrameRequestCallback[] = []
  const scroll = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 }
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
  const create = new Function('tick', 'requestAnimationFrame', 'settleScroll', 'options',
    `${executable}\nreturn new ConversationArrival(options);`)
  const arrival: Arrival = create(() => Promise.resolve(), (callback: FrameRequestCallback) => frames.push(callback), settleScroll, {
    viewState, scroll: () => scroll, follower: () => ({ jump, release, atEnd: true }),
    openingSearch: () => false, onSettled,
  })
  return { arrival, viewState, jump, release, onSettled, settleScroll, settled, restore,
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
  await Promise.resolve()
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
  await Promise.resolve()
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
