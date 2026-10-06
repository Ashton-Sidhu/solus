import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SOLUS_THEME_SNAPSHOT,
  SOLUS_THEME_VARIABLES,
  sandboxThemeCss,
} from '../../packages/contracts/src/artifact-sandbox'

const workspaceCss = readFileSync(join(import.meta.dir, '../../packages/workspace-ui/src/workspace.css'), 'utf8')

/** The declarations of the first block that opens with `selector`. */
function declarations(selector: string): Map<string, string> {
  const start = workspaceCss.indexOf(`\n${selector} {`)
  const body = workspaceCss.slice(start, workspaceCss.indexOf('\n}', start))
  const found = new Map<string, string>()
  for (const match of body.matchAll(/^\s*(--[a-z0-9-]+):\s*(.+?);/gm)) {
    if (!found.has(match[1])) found.set(match[1], match[2].trim())
  }
  return found
}

describe('the server preview wears the theme the reader sees', () => {
  test('every snapshot value is what workspace.css declares', () => {
    // WHY: the headless preview has no document to read the theme from. If the
    // snapshot drifts, the agent checks a page in colours the reader never sees.
    const light = declarations(':root')
    const dark = declarations('.dark')
    for (const variable of SOLUS_THEME_VARIABLES) {
      expect({ variable, value: SOLUS_THEME_SNAPSHOT.light[variable] }).toEqual({ variable, value: light.get(variable)! })
      // A variable the dark block does not restate keeps its light value.
      expect({ variable, value: SOLUS_THEME_SNAPSHOT.dark[variable] }).toEqual({ variable, value: dark.get(variable) ?? light.get(variable)! })
    }
  })

  test('the snapshot fills every token a render is taught', () => {
    for (const appearance of ['light', 'dark'] as const) {
      const css = sandboxThemeCss(appearance === 'dark', (variable) => SOLUS_THEME_SNAPSHOT[appearance][variable])
      for (const token of ['--background', '--foreground', '--card', '--border', '--primary', '--chart-1', '--chart-6', '--font-sans']) {
        expect(css).toMatch(new RegExp(`${token}:[^;]+;`))
      }
    }
  })
})
