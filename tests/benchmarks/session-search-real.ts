/** Session search quality on this machine's own Claude transcripts, read only.
 *
 * bun tests/benchmarks/session-search-real.ts --output /tmp/search-real.json
 *
 * Each transcript under ~/.claude/projects is read with the indexer's own
 * reader into a disposable SOLUS_DATA_DIR; the transcripts are never written.
 * Queries are drawn with a fixed seed, as a person who remembers a session
 * would type them: two neighbouring words they wrote in it, or two words of
 * its title. The session they came from is the answer. Targets are drawn
 * twice: weighted to recent sessions (half-life 14 days), as people mostly
 * look for recent work, and uniformly, so older work is not traded away.
 *
 * The report holds counts and ranks only, never transcript text: it is safe
 * to keep, the corpus is not. */
import { plugin } from 'bun'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
plugin({ setup(build) { build.module('node:sqlite', () => ({ exports: { DatabaseSync: Database }, loader: 'object' })) } })
const directory = mkdtempSync(join(tmpdir(), 'solus-search-real-'))
process.env.SOLUS_DATA_DIR = directory
process.env.SOLUS_DEV_LOG = join(directory, 'dev.log')
const { getDb, closeDb } = await import('@solus/server/db')
const indexer = await import('@solus/server/db/session-indexer')
const { readTailRecordBatches } = await import('@solus/server/db/session-file-reader')
const { searchSessionIndex } = await import('@solus/server/db/session-search')

const DAY = 86_400_000
const QUERIES_PER_SET = 150
const STOP = new Set('about above after again against also because been before being below between both but cannot could does doing down during each from further have having here hers herself himself into itself just more most myself once only other ours over same should some such than that their them then there these they this those through under until very want were what when where which while whom will with would your yours make sure need like know thing things still into just then dont doesnt cant wont should could would please okay yeah thanks right also now well even much many using used use make made take see look let lets get got one two way new add added adding'.split(' '))

let seed = 42
const random = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648 }
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!

interface Corpus { sessionId: string; title: string | null; last: number; userTexts: string[] }
const root = join(homedir(), '.claude', 'projects')
const corpus: Corpus[] = []
try {
  const started = performance.now()
  for (const project of readdirSync(root)) {
    const projectDir = join(root, project)
    if (!statSync(projectDir).isDirectory()) continue
    for (const name of readdirSync(projectDir)) {
      if (!name.endsWith('.jsonl')) continue
      const file = join(projectDir, name)
      const size = statSync(file).size
      if (size < 100) continue
      const sessionId = name.slice(0, -'.jsonl'.length)
      // The latest title line, as a provider-generated name.
      let title: string | null = null
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.includes('"ai-title"')) continue
        try { title = (JSON.parse(line) as { aiTitle?: string }).aiTitle ?? title } catch {}
      }
      const messages: Array<{ messageId?: string; role: 'user' | 'assistant'; content: string; timestamp: number }> = []
      for await (const batch of readTailRecordBatches(file, 0, size)) {
        for (const { message } of batch) {
          if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue
          messages.push({ messageId: message.uuid ?? undefined, role: message.role, content: message.text, timestamp: message.ts ?? 0 })
        }
      }
      if (!messages.length) continue
      const last = Math.max(...messages.map(message => message.timestamp))
      getDb().prepare(`INSERT INTO sessions(session_id, provider, cwd, project_path, project_root, custom_title, last_timestamp)
        VALUES (?, 'claude', ?, ?, ?, ?, ?)`).run(sessionId, project, project, project, title, last)
      indexer.indexSessionMessages(sessionId, messages)
      corpus.push({ sessionId, title, last, userTexts: messages.filter(message => message.role === 'user').map(message => message.content) })
    }
  }
  const indexMs = performance.now() - started
  const now = Math.max(...corpus.map(session => session.last))

  const words = (text: string) => text.match(/[A-Za-z][A-Za-z]+/g) ?? []
  const content = (word: string) => word.length >= 4 && !STOP.has(word.toLowerCase())
  // A message a person typed, not a pasted log or a command wrapper.
  const typed = (text: string) => text.length >= 20 && text.length <= 2000 && !text.trimStart().startsWith('<')
  function messageQuery(session: Corpus): string | null {
    const texts = session.userTexts.filter(typed)
    if (!texts.length) return null
    for (let attempt = 0; attempt < 8; attempt++) {
      const list = words(pick(texts))
      const pairs = list.slice(0, -1).flatMap((word, index) => content(word) && content(list[index + 1]!) ? [`${word} ${list[index + 1]}`] : [])
      if (pairs.length) return pick(pairs).toLowerCase()
    }
    return null
  }
  function titleQuery(session: Corpus, filler: boolean): string | null {
    const list = words(session.title ?? '').filter(word => word.length >= 3 && !STOP.has(word.toLowerCase()))
    if (list.length < 2) return null
    const at = Math.floor(random() * (list.length - 1))
    return (filler ? `${list[at]} the ${list[at + 1]}` : `${list[at]} ${list[at + 1]}`).toLowerCase()
  }
  function draw(weighted: boolean, eligible: Corpus[]): Corpus {
    if (!weighted) return pick(eligible)
    const weights = eligible.map(session => 2 ** (-(now - session.last) / (14 * DAY)))
    let at = random() * weights.reduce((sum, weight) => sum + weight, 0)
    for (let index = 0; index < eligible.length; index++) { at -= weights[index]!; if (at <= 0) return eligible[index]! }
    return eligible.at(-1)!
  }

  type Kind = 'message' | 'title' | 'title+filler'
  const sets: Array<{ name: string; kind: Kind; weighted: boolean }> = [
    { name: 'message, recent', kind: 'message', weighted: true },
    { name: 'message, uniform', kind: 'message', weighted: false },
    { name: 'title, recent', kind: 'title', weighted: true },
    { name: 'title, uniform', kind: 'title', weighted: false },
    { name: 'title with "the", recent', kind: 'title+filler', weighted: true },
  ]
  const report = { sessions: corpus.length, messages: Number(getDb().prepare('SELECT COUNT(*) AS n FROM session_messages').get()?.n), indexMs: Math.round(indexMs), sets: [] as unknown[] }
  for (const set of sets) {
    const eligible = corpus.filter(session => set.kind === 'message' ? session.userTexts.some(typed) : (session.title ?? '').split(/\s+/).length >= 2)
    const ranks: Array<number | null> = []
    const times: number[] = []
    let unmatched = 0
    for (let drawn = 0; ranks.length < QUERIES_PER_SET && drawn < QUERIES_PER_SET * 5; drawn++) {
      const target = draw(set.weighted, eligible)
      const query = set.kind === 'message' ? messageQuery(target) : titleQuery(target, set.kind === 'title+filler')
      if (!query) continue
      // Another session with the same title is the same answer to a title query.
      const answers = new Set(set.kind === 'message' ? [target.sessionId] : corpus.filter(session => session.title === target.title).map(session => session.sessionId))
      const start = performance.now()
      const page = searchSessionIndex(query, { limit: 50, now } as Parameters<typeof searchSessionIndex>[1])
      times.push(performance.now() - start)
      const at = page.results.findIndex(result => answers.has(result.session.sessionId))
      ranks.push(at < 0 ? null : at + 1)
      if (at < 0) {
        // Past the first page, or not matched at all.
        let deeper = -1
        for (let offset = 50; offset < page.total && deeper < 0; offset += 50) {
          const index = searchSessionIndex(query, { limit: 50, offset, now } as Parameters<typeof searchSessionIndex>[1]).results.findIndex(result => answers.has(result.session.sessionId))
          if (index >= 0) deeper = offset + index + 1
        }
        if (deeper < 0) unmatched += 1
        if (process.env.SEARCH_DEBUG && deeper < 0) console.error('unmatched', set.name, JSON.stringify(query), target.sessionId)
      }
    }
    times.sort((a, b) => a - b)
    const share = (limit: number) => +(ranks.filter(rank => rank !== null && rank <= limit).length / ranks.length).toFixed(3)
    report.sets.push({
      set: set.name,
      queries: ranks.length,
      hitAt1: share(1),
      hitAt3: share(3),
      hitAt10: share(10),
      mrr: +(ranks.reduce<number>((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / ranks.length).toFixed(3),
      missing: ranks.filter(rank => rank === null).length,
      unmatched,
      medianMs: +times[Math.floor(times.length / 2)]!.toFixed(2),
      p95Ms: +times[Math.floor(times.length * 0.95)]!.toFixed(2),
    })
  }
  const outputIndex = process.argv.indexOf('--output')
  const output = outputIndex < 0 ? join(tmpdir(), 'session-search-real.json') : process.argv[outputIndex + 1]!
  console.log(JSON.stringify(report, null, 2))
  writeFileSync(output, JSON.stringify(report, null, 2))
} finally { closeDb(); rmSync(directory, { recursive: true, force: true }) }
