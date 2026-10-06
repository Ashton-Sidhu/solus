import { describe, expect, test } from 'bun:test'
import {
  inlineLocalImages,
  localImagePath,
  localImageReferences,
} from '../../packages/contracts/src/html-local-images'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
const PNG_DATA_URL = 'data:image/png;base64,iVBORw=='

describe('which references are local images', () => {
  test('an absolute path or a file: URL to an image names a host file', () => {
    expect(localImagePath('/tmp/shot.png')).toBe('/tmp/shot.png')
    expect(localImagePath('file:///tmp/my%20shot.webp')).toBe('/tmp/my shot.webp')
  })

  test('web, data, and relative references are left to the browser', () => {
    // WHY: only a host path is unreachable from the sandbox frame. Rewriting
    // anything else would break a page that already works.
    expect(localImagePath('https://example.com/a.png')).toBeNull()
    expect(localImagePath('//cdn.example.com/a.png')).toBeNull()
    expect(localImagePath('data:image/png;base64,AAAA')).toBeNull()
    expect(localImagePath('shot.png')).toBeNull()
  })

  test('a local file that is not an image is not read', () => {
    // WHY: a page may reference a local script or stylesheet. Writing that into
    // the page as an image would not run it, and reads a file nobody asked to show.
    expect(localImagePath('/repo/app.js')).toBeNull()
    expect(localImagePath('/repo/.env')).toBeNull()
  })

  test('img src, script src assignments, and CSS url() are all found', () => {
    const html = `<img src="/a.png"><div style="background:url('/b.jpg')"></div>
<script>img.src = '/c.gif'</script><style>.x{background:url(/d.webp)}</style>`
    expect([...localImageReferences(html).keys()]).toEqual(['/a.png', '/c.gif', '/b.jpg', '/d.webp'])
  })
})

describe('writing local images into the page', () => {
  test('each local image becomes a data: URL typed by its extension', async () => {
    const html = '<img src="/tmp/shot.png"><i style="background:url(/tmp/shot.png)"></i>'
    const inlined = await inlineLocalImages(html, async () => new Blob([PNG], { type: 'application/octet-stream' }))
    expect(inlined).toEqual({ html: `<img src="${PNG_DATA_URL}"><i style="background:url(${PNG_DATA_URL})"></i>`, missing: [] })
  })

  test('an image the host cannot serve stays as written and the rest still load', async () => {
    // WHY: one missing screenshot must not stop the page from rendering.
    const html = '<img src="/gone.png"><img src="/here.png">'
    const inlined = await inlineLocalImages(html, async (path) => {
      if (path === '/gone.png') throw new Error('not found')
      return new Blob([PNG])
    })
    // The preview names it, so the agent can fix the path.
    expect(inlined).toEqual({ html: `<img src="/gone.png"><img src="${PNG_DATA_URL}">`, missing: ['/gone.png'] })
  })

  test('markup with no local image is returned untouched without reading anything', async () => {
    let reads = 0
    const html = '<img src="https://example.com/a.png">'
    expect(await inlineLocalImages(html, async () => { reads++; return null })).toEqual({ html, missing: [] })
    expect(reads).toBe(0)
  })
})
