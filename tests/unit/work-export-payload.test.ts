import { describe, expect, test } from 'bun:test'
import {
  dataUrlToPayload,
  exportFrame,
  exportPixelRatio,
  type DiagramExportFlow,
} from '@solus/workspace-ui/components/diagram/lib/diagram-export'
import { exportFileName } from '@solus/workspace-ui/components/pickers/lib/export-file-name'

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

describe('export pixel ratio', () => {
  test('a small graph is rasterized at 2× or the display ratio, whichever is higher', () => {
    // WHY: a 1× display would otherwise write a PNG that is soft on a page.
    expect(exportPixelRatio(1000, 600, 1)).toBe(2)
    expect(exportPixelRatio(1000, 600, 3)).toBe(3)
  })

  test('a large graph is scaled down so the PNG stays under the Docs inline-image ceiling', () => {
    // WHY: Docs rejected a real publish with "The provided image is too
    // large" once a 2× capture of a big graph passed 25 megapixels. The
    // budget sits clear of that, and a figure asking for a 200%-zoom raster
    // is held to it too.
    const ratio = exportPixelRatio(5000, 3000, 2)
    expect(ratio).toBeLessThan(2)
    expect(5000 * ratio * (3000 * ratio)).toBeLessThanOrEqual(20_000_000)
    expect(5000 * exportPixelRatio(5000, 3000, 8) * (3000 * exportPixelRatio(5000, 3000, 8))).toBeLessThanOrEqual(20_000_000)
  })
})

describe('export frame', () => {
  test('it uses the flow bounds so child nodes have absolute sub-flow positions', () => {
    const flow = {
      getNodes: () => [],
      getNodesBounds: () => ({ x: 400, y: 300, width: 700, height: 500 }),
    } satisfies DiagramExportFlow

    expect(exportFrame(flow)).toEqual({ width: 780, height: 580 })
  })
})

describe('export file names', () => {
  test('a title becomes a lowercase snake-case name for any format', () => {
    // WHY: work and plan titles stay readable in the UI, but their exported
    // files need one predictable name on every supported filesystem.
    expect(exportFileName('API / rollout', 'MD')).toBe('api_rollout.md')
    expect(exportFileName('System   map', 'png')).toBe('system_map.png')
  })

  test('an untitled work still gets a name to save under', () => {
    expect(exportFileName('', 'md', 'plan')).toBe('plan.md')
    expect(exportFileName('   ', 'json')).toBe('work.json')
  })

  test('separators never survive into the name, so a title cannot redirect the write', () => {
    expect(exportFileName('../../etc/passwd', 'md')).toBe('.._.._etc_passwd.md')
  })
})
