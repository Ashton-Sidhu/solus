/** Synthetic wire-byte comparison; no server or live session data is used. */
import { projectSessionHistory, serializedBytes } from '../packages/server/src/server/result-projection'
import { deferSessionToolInputs, selectSessionToolInputs } from '../packages/server/src/server/session-tool-inputs'

const messages = Array.from({ length: 200 }, (_, index) => ({
  role: 'tool', toolId: `tool-${index}`, toolName: 'exec_command',
  toolInput: JSON.stringify({ cmd: `echo ${index}\n` + 'x'.repeat(8000) }),
  content: '', timestamp: index,
}))
const full = projectSessionHistory(messages)
const summaries = deferSessionToolInputs(full)
const keys = summaries.slice(0, 10).flatMap((message) => message.toolInputKey ? [message.toolInputKey] : [])
const selected = selectSessionToolInputs(messages, keys)
console.log(JSON.stringify({
  tools: messages.length,
  fullBytes: serializedBytes(full),
  initialSummaryBytes: serializedBytes(summaries),
  inputsBeforeClick: summaries.filter((message) => message.toolInput).length,
  inputsOnOneSummaryClick: selected.length,
  clickedSummaryBytes: serializedBytes(selected),
}, null, 2))
