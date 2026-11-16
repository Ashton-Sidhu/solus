import { describe, expect, test } from 'bun:test'
import { MAX_FILE_BYTES, findStepPlace, readStepSourceFiles, stepSourcePaths, type StepSourceFile } from '@solus/server/apps/app-step-source'

// WHY: the Workflows section's Code button opens the line of a step's
// `step.do('<name>'` call. A near name, or the same name in another
// workflow, opens the wrong code, which is worse than no button.

const APP = `import { defineApp, workflow } from '@solus/app/backend'

export default defineApp({
  workflows: {
    summarize: workflow({}, async (ctx) => {
      const notes = await ctx.step.do('fetch-notes', async () => [])
      const repo = await ctx.step.do("fetch", async () => null)
      await ctx.step.do(\`ask-model\`, async () => notes)
    }),
    "nightly": workflow({}, async ({ step }) => {
      await step.do('fetch', async () => null)
      await step.do( 'store-summary', async () => null)
    }),
  },
})
`

const HELPERS = `export async function storeLater(steps) {
  return steps.do('send-digest', async () => true)
}
`

const files: StepSourceFile[] = [
  { path: 'app.ts', text: APP },
  { path: 'src/steps.ts', text: HELPERS },
]

describe('the place of a step in the source', () => {
  test('the exact name matches, never a name that starts the same', () => {
    expect(findStepPlace(files, 'summarize', 'fetch')).toEqual({ path: 'app.ts', line: 7, column: 30 })
    expect(findStepPlace(files, 'summarize', 'fetch-notes')).toEqual({ path: 'app.ts', line: 6, column: 31 })
  })

  test('the same name in two workflows opens the step of the workflow asked for', () => {
    expect(findStepPlace(files, 'nightly', 'fetch')).toEqual({ path: 'app.ts', line: 11, column: 13 })
  })

  test('each quote, and space after the parenthesis, still match', () => {
    expect(findStepPlace(files, 'summarize', 'ask-model')).toEqual({ path: 'app.ts', line: 8, column: 17 })
    expect(findStepPlace(files, 'nightly', 'store-summary')).toEqual({ path: 'app.ts', line: 12, column: 13 })
  })

  test('a step in another file, with another receiver, is found when no workflow declaration holds it', () => {
    expect(findStepPlace(files, 'digest', 'send-digest')).toEqual({ path: 'src/steps.ts', line: 2, column: 10 })
  })

  test('a step that the source does not call answers null', () => {
    expect(findStepPlace(files, 'summarize', 'release.summarized')).toBeNull()
    expect(findStepPlace(files, 'summarize', 'fetch-')).toBeNull()
  })
})

describe('the bounded read', () => {
  test('only source files outside the package and build folders, in path order', () => {
    expect(stepSourcePaths(['src/b.ts', 'app.ts', 'node_modules/x/index.js', 'dist/app.js', 'types.d.ts', 'README.md', 'migrations/0001.sql', 'src/a.tsx'])).toEqual(['app.ts', 'src/a.tsx', 'src/b.ts'])
  })

  test('a file larger than the limit is not read', async () => {
    const read = await readStepSourceFiles(['app.ts', 'big.ts'], async (path) => (path === 'big.ts' ? Buffer.alloc(MAX_FILE_BYTES + 1, 'a') : Buffer.from(APP)))
    expect(read.map((file) => file.path)).toEqual(['app.ts'])
  })
})
