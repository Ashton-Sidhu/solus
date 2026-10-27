/** Same deterministic corpus before and after. All data is disposable.
 * bun tests/benchmarks/session-search-quality.ts --output <result.json> */
import { plugin } from 'bun'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
plugin({ setup(build) { build.module('node:sqlite', () => ({ exports: { DatabaseSync: Database }, loader: 'object' })) } })
const directory = mkdtempSync(join(tmpdir(), 'solus-search-quality-'))
process.env.SOLUS_DATA_DIR = directory
process.env.SOLUS_DEV_LOG = join(directory, 'dev.log')
const { getDb, closeDb } = await import('@solus/server/db')
const indexer = await import('@solus/server/db/session-indexer')
const { searchSessionIndex } = await import('@solus/server/db/session-search')
const now = Date.UTC(2026, 9, 26)
interface Case { query: string; target: string; projectRoot?: string; namesOnly?: boolean }
const cases: Case[] = []
function seed(sessionId: string, title: string, messages: string[], project = '/bench', timestamp = now) {
  getDb().prepare(`INSERT INTO sessions(session_id, provider, cwd, project_path, project_root, custom_title, last_timestamp)
    VALUES (?, 'codex', ?, ?, ?, ?, ?)`).run(sessionId, project, project, project, title, timestamp)
  indexer.indexSessionMessages(sessionId, messages.map((content, index) => ({ role: index % 2 ? 'assistant' : 'user', content, timestamp: now - 1000 + index })))
}
try {
  for (let i = 0; i < 2000; i++) seed(`noise-${i}`, `Investigate session reconnect ${i}`, Array.from({ length: 30 }, (_, j) => `The session ${i} reconnect path needs a test for the sidebar ${j}.`))
  for (const [query, title] of [['connections', 'serverConnections'], ['schema', 'JSONSchema'], ['cafe', 'Café'], ['keybindngs', 'Keybindings'], ['vscode', 'VS Code'], ['reconnect websocket', 'Websocket reconnect']] as const) {
    seed(title, title, ['unrelated words'])
    cases.push({ query, target: title, namesOnly: true })
  }
  seed('old-exact', 'Tab', ['unrelated'], '/titles', now - 90 * 86_400_000)
  for (let i = 0; i < 35; i++) seed(`tab-${i}`, `Tab details ${i}`, ['unrelated'], '/titles')
  cases.push({ query: 'tab', target: 'old-exact', projectRoot: '/titles', namesOnly: true })
  seed('phrase', '', ['websocket reconnect'], '/scope')
  seed('spread', '', ['websocket', 'reconnect'], '/scope')
  for (let i = 0; i < 6; i++) seed(`outside-${i}`, '', ['websocket reconnect'], '/other')
  cases.push({ query: 'websocket reconnect', target: 'phrase', projectRoot: '/scope' })
  seed('across', '', ['the lighthouse audit failed', 'we added a cache header'])
  cases.push({ query: 'lighthouse header', target: 'across' })
  seed('message-camel', '', ['check the serverConnections store'])
  cases.push({ query: 'connections store', target: 'message-camel' })
  seed('old-history', '', ['pelican migration plan'], '/bench', now - 200 * 86_400_000)
  cases.push({ query: 'pelican migration', target: 'old-history' })
  const results = cases.map(test => {
    const run = () => searchSessionIndex(test.query, { projectRoot: test.projectRoot, namesOnly: test.namesOnly, limit: 30 })
    for (let warmup = 0; warmup < 3; warmup++) run()
    const times: number[] = []
    for (let repeat = 0; repeat < 15; repeat++) { const start = performance.now(); run(); times.push(performance.now() - start) }
    times.sort((a, b) => a - b)
    const page = run()
    const at = page.results.findIndex(result => result.session.sessionId === test.target)
    return { ...test, rank: at < 0 ? null : at + 1, medianMs: times[7], p95Ms: times[14], total: page.total }
  })
  const outputIndex = process.argv.indexOf('--output')
  const output = outputIndex < 0 ? new URL('./session-search-quality-results.json', import.meta.url).pathname : process.argv[outputIndex + 1]
  if (!output) throw new Error('--output needs a path')
  const report = { seed: 42, sessions: Number(getDb().prepare('SELECT COUNT(*) AS n FROM sessions').get()?.n), messages: Number(getDb().prepare('SELECT COUNT(*) AS n FROM session_messages').get()?.n), hitAt1: results.filter(result => result.rank === 1).length / results.length,
    mrr: results.reduce((sum, result) => sum + (result.rank ? 1 / result.rank : 0), 0) / results.length, results }
  console.log(JSON.stringify(report, null, 2))
  writeFileSync(output, JSON.stringify(report, null, 2))
} finally { closeDb(); rmSync(directory, { recursive: true, force: true }) }
