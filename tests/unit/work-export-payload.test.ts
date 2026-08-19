import { describe, expect, test } from 'bun:test'
import { dataUrlToPayload } from '../../src/renderer/components/diagram/lib/diagram-export'
import { exportFileName } from '../../src/renderer/components/pickers/lib/export-file-name'

/**
 * `html-to-image` hands back a different data-URL encoding per format, and the
 * write RPC is a string field either way — so reading the URL's own encoding is
 * the only thing standing between an SVG export and a file full of `%3Csvg`.
 */
describe('export payloads', () => {
  test('a base64 data URL stays base64 for the write', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')

    expect(dataUrlToPayload(`data:image/png;base64,${bytes}`)).toEqual({
      contents: bytes,
      encoding: 'base64',
    })
  })

  test('a percent-encoded data URL is decoded to the text it stands for', () => {
    const svg = '<svg width="10"><rect fill="#fff"/></svg>'

    expect(dataUrlToPayload(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)).toEqual({
      contents: svg,
      encoding: 'utf8',
    })
  })
})

describe('export file names', () => {
  test('a title becomes a portable name for any format', () => {
    expect(exportFileName('API / rollout', 'md')).toBe('API _ rollout.md')
    expect(exportFileName('System map', 'png')).toBe('System map.png')
  })

  test('an untitled work still gets a name to save under', () => {
    expect(exportFileName('', 'md', 'plan')).toBe('plan.md')
    expect(exportFileName('   ', 'json')).toBe('work.json')
  })

  test('separators never survive into the name, so a title cannot redirect the write', () => {
    expect(exportFileName('../../etc/passwd', 'md')).toBe('.._.._etc_passwd.md')
  })
})
