import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../../packages/workspace-ui/src/lib/mount-timing.ts', import.meta.url), 'utf8')
const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.replace(/^import .*\n/gm, '')).replaceAll('export ', '')

function fixture() {
  const measures: Array<{ name: string; detail: { tabId: string } }> = []
  const frames = new Map<number, () => void>()
  const listeners = new Set<() => void>()
  let nextFrame = 0
  const document = {
    visibilityState: 'visible',
    addEventListener(_name: string, callback: () => void) { listeners.add(callback) },
    removeEventListener(_name: string, callback: () => void) { listeners.delete(callback) },
  }
  const create = new Function('performance', 'document', 'requestAnimationFrame', 'cancelAnimationFrame',
    `${executable}\nreturn transcriptPaintProfiler();`)
  const observe: (tabId: string) => (() => void) | undefined = create(
    { now: () => 10, measure: (name: string, options: { detail: { tabId: string } }) => measures.push({ name, detail: options.detail }) },
    document,
    (callback: () => void) => { frames.set(++nextFrame, callback); return nextFrame },
    (frame: number) => frames.delete(frame),
  )
  return { observe, measures, frames, listeners, document,
    frame() {
      const callbacks = [...frames.values()]
      frames.clear()
      for (const callback of callbacks) callback()
    },
  }
}

test('paint requires two visible frames and is reported only once per mount', () => {
  const f = fixture()
  f.observe('tab')
  f.frame()
  expect(f.measures).toHaveLength(0)
  f.frame()
  expect(f.measures).toEqual([{ name: 'solus.open.transcriptPaint', detail: { tabId: 'tab' } }])
  expect(f.listeners.size).toBe(0)
  expect(f.observe('tab')).toBeUndefined()
})

test('hidden and unmounted transcripts cannot report a paint', () => {
  const f = fixture()
  f.document.visibilityState = 'hidden'
  const stop = f.observe('tab')
  expect(f.frames.size).toBe(0)
  f.document.visibilityState = 'visible'
  for (const listener of f.listeners) listener()
  f.frame()
  stop?.()
  f.frame()
  expect(f.measures).toHaveLength(0)
  expect(f.listeners.size).toBe(0)
})
