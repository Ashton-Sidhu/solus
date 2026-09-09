import { afterEach, describe, expect, test } from 'bun:test'
import { wrapSandboxSrcdoc } from '../../packages/workspace-ui/src/lib/artifactSandbox'

const previousDocument = globalThis.document
const previousGetComputedStyle = globalThis.getComputedStyle

afterEach(() => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument })
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: previousGetComputedStyle })
})

function stubTheme(isDark: boolean): void {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { documentElement: {} },
  })
  Object.defineProperty(globalThis, 'getComputedStyle', {
    configurable: true,
    value: () => ({
      getPropertyValue: (name: string) =>
        name === '--solus-container-bg' ? (isDark ? '#262522' : '#fefefc') : '',
    }),
  })
}

describe('what a render is allowed to load', () => {
  test('any https origin serves a render, and a render may fetch', () => {
    // WHY: the frame exists for fidelity, not containment. A three-CDN
    // allowlist and `connect-src 'none'` made ordinary pages — a font, a
    // library on a different host, a chart that reads an API — render broken
    // with nothing on screen to say why. What holds the line is the iframe's
    // sandbox attribute withholding allow-same-origin, not this policy.
    stubTheme(true)
    const srcdoc = wrapSandboxSrcdoc('<p>x</p>', true)

    expect(srcdoc).toContain("script-src 'unsafe-inline' https:;")
    expect(srcdoc).toContain("style-src 'unsafe-inline' https:;")
    expect(srcdoc).toContain('img-src data: blob: https:;')
    expect(srcdoc).toContain('connect-src https:;')
    expect(srcdoc).not.toContain('cdn.jsdelivr.net')
    expect(srcdoc).not.toContain("connect-src 'none'")
  })

  test('nothing else is granted by default', () => {
    // WHY: `default-src 'none'` is what keeps a render from framing another
    // page or opening a worker; the widened directives are enumerated, not a
    // blanket allow.
    stubTheme(true)
    expect(wrapSandboxSrcdoc('<p>x</p>', true)).toContain("default-src 'none';")
  })
})

test('a theme message updates the existing stylesheet without rerunning the document', async () => {
  const { runInNewContext } = await import('node:vm')
  const { buildSandboxThemeCss } = await import('../../packages/workspace-ui/src/lib/artifactSandbox')
  stubTheme(false)
  const srcdoc = wrapSandboxSrcdoc('<input value="changed">', false)
  const reporter = /<script>([\s\S]*?)<\/script>/.exec(srcdoc)![1]
  const style = { textContent: buildSandboxThemeCss(false) }
  const parent = { postMessage() {} }
  let onMessage: ((event: { source: object; data: { type: string; css: string } }) => void) | undefined
  let loaded = 0
  runInNewContext(reporter, {
    parent,
    document: {
      readyState: 'loading',
      getElementById: () => style,
      addEventListener() { loaded++ },
    },
    window: {
      addEventListener(type: string, listener: typeof onMessage) {
        if (type === 'message') onMessage = listener
      },
    },
    setTimeout() {},
  })
  stubTheme(true)
  const css = buildSandboxThemeCss(true)
  onMessage?.({ source: {}, data: { type: 'solus-artifact-theme', css } })
  expect(style.textContent).toContain('color-scheme:light')
  onMessage?.({ source: parent, data: { type: 'solus-artifact-theme', css } })
  expect(style.textContent).toContain('color-scheme:dark')
  expect(style.textContent).toContain('--solus-container-bg:#262522')
  expect(loaded).toBe(1)
})
