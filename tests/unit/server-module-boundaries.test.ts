import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'fs'
import { dirname, join, relative, resolve } from 'path'

// plans/007-solus-api-organization-refactor.md: the server is grouped by
// responsibility. Data (records, schemas, domain rules) must stay usable
// without the execution runtime, the delivery pipeline, or a transport;
// admission and host configuration are leaves; Sync uses Data and never a
// transport; Execution never reaches into Transport. Every dependency that
// still crosses a boundary is listed here by name, so removing one is a
// deliberate change and adding one fails this test.

const serverSrc = resolve(import.meta.dir, '../../packages/server/src')

/** The top-level folder (or file) a server module belongs to. */
function areaOf(file: string): string {
  const [head] = file.split('/')
  return head.includes('.') ? file : head
}

const forbidden: Record<string, readonly string[]> = {
  data: ['execution', 'sync', 'transport', 'boot-server.ts', 'boot-core.ts'],
  admission: ['data', 'execution', 'sync', 'transport', 'boot-server.ts', 'boot-core.ts'],
  host: ['data', 'execution', 'sync', 'transport', 'boot-server.ts', 'boot-core.ts'],
  files: ['data', 'execution', 'sync', 'transport', 'boot-server.ts', 'boot-core.ts'],
  sync: ['execution', 'transport', 'boot-server.ts', 'boot-core.ts'],
  execution: ['transport', 'boot-server.ts', 'boot-core.ts'],
}

/**
 * Crossings the refactor kept because removing them changes behavior. Each is
 * assigned to the original cloud service-model feature plan (work
 * de142de0-7fbf-4ed2-a7e6-4cb982a733f2): the outbox applier registry and the
 * pending-op reads go with the scoped delivery work; linked content reading a
 * live session goes with publication.
 */
const exceptions: ReadonlySet<string> = new Set([
  'data/tasks/task-applier.ts -> sync/outbox/outbox-store.ts',
  'data/works/work-applier.ts -> sync/outbox/outbox-store.ts',
  'data/sessions/session-applier.ts -> sync/outbox/outbox-store.ts',
  'data/tasks/foreign-tasks.ts -> sync/outbox/outbox-store.ts',
  'data/tasks/linked-content.ts -> execution/agents/tools/session-tools.ts',
])

const specifierPattern = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"\n]+)['"]/g

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  let base: string
  if (specifier.startsWith('@solus/server/')) base = join(serverSrc, specifier.slice('@solus/server/'.length))
  else if (specifier.startsWith('.')) base = resolve(dirname(join(serverSrc, fromFile)), specifier)
  else return null
  for (const candidate of [`${base}.ts`, join(base, 'index.ts'), base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return relative(serverSrc, candidate)
  }
  return null
}

function crossings(): { violations: string[]; unusedExceptions: string[] } {
  const files = Array.from(new Bun.Glob('**/*.ts').scanSync({ cwd: serverSrc })).filter((file) => !file.includes('/generated/'))
  const seen = new Set<string>()
  const violations: string[] = []
  for (const file of files.sort()) {
    const rules = forbidden[areaOf(file)]
    if (!rules) continue
    const text = readFileSync(join(serverSrc, file), 'utf8')
    for (const match of text.matchAll(specifierPattern)) {
      const target = resolveSpecifier(file, match[1])
      if (!target || !rules.includes(areaOf(target))) continue
      const edge = `${file} -> ${target}`
      if (exceptions.has(edge)) seen.add(edge)
      else violations.push(edge)
    }
  }
  return { violations, unusedExceptions: [...exceptions].filter((edge) => !seen.has(edge)) }
}

describe('server module boundaries', () => {
  test('every module lives in an area the plan names', () => {
    for (const area of ['admission', 'host', 'files', 'data', 'execution', 'sync', 'transport']) {
      expect(existsSync(join(serverSrc, area))).toBe(true)
    }
    // WHY: the old folders must not come back as a second home for the same code.
    for (const retired of ['server', 'agents', 'sessions', 'tasks', 'folio', 'mirror', 'outbox', 'transports', 'events', 'orchestration', 'seats', 'observability', 'control-plane.ts']) {
      expect(existsSync(join(serverSrc, retired))).toBe(false)
    }
  })

  test('data, admission, host, files, sync and execution import only what their area allows', () => {
    const { violations, unusedExceptions } = crossings()
    // WHY: a listed exception that no longer exists is stale documentation;
    // an unlisted crossing is a boundary quietly given up.
    expect(violations).toEqual([])
    expect(unusedExceptions).toEqual([])
  })

  test('the mirrored tables register in the same order as before the split', async () => {
    const { PORTED_TABLES } = await import('@solus/server/db/schema/index')
    const names = PORTED_TABLES.map((table) => table.name)
    const transcripts = names.indexOf('session_transcripts')
    // WHY: generated migrations and the runner cursors depend on the table order staying put.
    expect(names.slice(transcripts, transcripts + 3)).toEqual(['session_transcripts', 'insight_spans', 'insight_log_events'])
    expect(names[transcripts - 1]).toBe('runner_cursors')
  })
})
