import { expect, test } from 'bun:test'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import { INITIAL_HISTORY_TURNS } from '@solus/client-core/session-history-page'
import { projectSessionHistory } from '@solus/server/data/sessions/result-projection'
import { deferSessionToolInputs } from '@solus/server/data/sessions/session-tool-inputs'

// WHY: a conversation opens with a fixed number of turns, so its first paint is
// only as cheap as the rows in them. A busy turn runs dozens of tools; if their
// file bodies, patches or outputs cross the wire again, the first page grows by
// an order of magnitude. This is the wire the host sends for such a page.
//
// The budget is ~27% above the measured 118 KB. Tool results alone (without
// deferred inputs) measured 1.67 MB; the raw page 3.2 MB.
const FIRST_PAGE_BUDGET_BYTES = 150 * 1024

function busyPage(): SessionLoadMessage[] {
  const body = 'export const value = compute(input);\n'.repeat(100)
  const page: SessionLoadMessage[] = []
  let timestamp = 0
  for (let turn = 0; turn < INITIAL_HISTORY_TURNS; turn++) {
    page.push({ role: 'user', content: `Prompt ${turn}`, timestamp: ++timestamp })
    for (let step = 0; step < 40; step++) {
      const toolId = `tool-${turn}-${step}`
      const filePath = `/repo/src/file-${step}.ts`
      page.push({
        role: 'tool', toolId, toolName: step % 2 ? 'Edit' : 'Read', content: '', timestamp: ++timestamp,
        toolInput: JSON.stringify(step % 2 ? { file_path: filePath, old_string: body, new_string: body } : { file_path: filePath }),
      })
      page.push({ role: 'tool_result', toolResultForId: toolId, content: body, timestamp: ++timestamp })
    }
    page.push({ role: 'assistant', content: 'Done. '.repeat(40), timestamp: ++timestamp })
  }
  return page
}

test(`a busy session's first page (${INITIAL_HISTORY_TURNS} turns of 40 tools) stays within its wire budget`, () => {
  const wire = deferSessionToolInputs(projectSessionHistory(busyPage()))
  const bytes = JSON.stringify(wire).length
  expect(bytes).toBeLessThanOrEqual(FIRST_PAGE_BUDGET_BYTES)
  // Every Edit still names its file for the folded row and the changed-files list.
  const edits = wire.filter((message) => message.toolName === 'Edit')
  expect(edits.every((message) => JSON.parse(message.toolInput!).file_path)).toBe(true)
})
