import { describe, expect, test } from 'bun:test'
import {
  artifactHasBody,
  partialArtifactHtml,
} from '../../packages/workspace-ui/src/contexts/workspace/streaming-artifact'

describe('a render_artifact call that is still being written', () => {
  test('the html argument is readable before the JSON closes', () => {
    // WHY: `JSON.parse` cannot read a fragment, so waiting for the call to
    // close means the whole document appears at once after a long skeleton.
    const input = '{"title":"Chart","html":"<!doctype html>\\n<body><h1>Hi'
    expect(partialArtifactHtml(input)).toBe('<!doctype html>\n<body><h1>Hi')
  })

  test('a closed argument stops at its quote', () => {
    const input = '{"html":"<body>x</body>","title":"Chart"}'
    expect(partialArtifactHtml(input)).toBe('<body>x</body>')
  })

  test('escaped quotes inside the markup are markup, not the end of it', () => {
    // WHY: every attribute in a document is quoted. Treating the first escaped
    // quote as the end would cut the render off at its first tag.
    const input = '{"html":"<body class=\\"card\\">x'
    expect(partialArtifactHtml(input)).toBe('<body class="card">x')
  })

  test('an escape split across chunks is dropped, not guessed', () => {
    // WHY: the next chunk brings it. Half an escape on screen is worse than
    // one frame of missing character.
    expect(partialArtifactHtml('{"html":"<body>a\\')).toBe('<body>a')
    expect(partialArtifactHtml('{"html":"<body>a\\u00')).toBe('<body>a')
  })

  test('a call with no html argument yet reads as nothing', () => {
    expect(partialArtifactHtml('{"title":"Chart"')).toBeNull()
  })

  test('rendering waits for a body', () => {
    // WHY: a `<head>` alone paints nothing, so the frame would flash empty and
    // then fill. The first thing the reader sees should be content.
    expect(artifactHasBody('<!doctype html><head><title>x</title></head>')).toBe(false)
    expect(artifactHasBody('<!doctype html><body>')).toBe(true)
    expect(artifactHasBody('<body class="card">')).toBe(true)
    expect(artifactHasBody('<bodyguard>')).toBe(false)
  })
})
