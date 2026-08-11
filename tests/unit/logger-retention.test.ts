import { describe, expect, test } from 'bun:test'
import { serializeLogEntry } from '../../src/main/logger'

describe('logger retention bounds', () => {
  test('serializes large object graphs into a valid byte-bounded NDJSON entry', () => {
    const circular: { self?: object } = {}
    circular.self = circular
    const line = serializeLogEntry({
      ts: new Date(0).toISOString(),
      level: 'info',
      tag: 'test',
      file: 'test.ts',
      msg: 'large_graph',
      events: Array.from({ length: 10_000 }, (_, index) => ({ index, text: 'x'.repeat(4_000) })),
      circular,
    })

    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(64 * 1024)
    expect(() => JSON.parse(line)).not.toThrow()
    expect(line).toContain('items]')
    expect(line).toContain('[Circular]')
  })
})
