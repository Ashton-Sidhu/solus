import type { Database } from 'bun:sqlite'
import type { DatabaseSync } from 'node:sqlite'

/**
 * Every statement the host's one SQLite connection runs, in order, with its
 * bound parameter count: what a test asserts a request's reads and writes on.
 * The connection caches compiled statements, so a statement is wrapped once
 * however many times it is prepared. Wrap the connection before anything
 * prepares a statement it will reuse. PRAGMAs are not recorded.
 */
export interface LoggedStatement {
  /** The statement text, whitespace collapsed. */
  text: string
  /** The number of values bound to it. */
  params: number
}

export class StatementLog {
  readonly statements: LoggedStatement[] = []

  constructor(connection: DatabaseSync) {
    const db = connection as unknown as Database
    const prepare = db.prepare.bind(db)
    const exec = db.exec.bind(db)
    db.exec = ((text: string) => { this.record(text, 0); return exec(text) }) as Database['exec']
    const wrapped = new WeakSet<object>()
    db.prepare = ((text: string) => {
      const statement = prepare(text)
      if (wrapped.has(statement)) return statement
      wrapped.add(statement)
      for (const method of ['run', 'get', 'all', 'values'] as const) {
        const original = statement[method].bind(statement)
        statement[method] = ((...args: never[]) => { this.record(text, args.length); return original(...args) }) as never
      }
      return statement
    }) as Database['prepare']
  }

  private record(text: string, params: number): void {
    const statement = text.trim().replace(/\s+/g, ' ')
    if (/^PRAGMA/i.test(statement)) return
    this.statements.push({ text: statement, params })
  }

  clear(): void {
    this.statements.length = 0
  }

  /** The statements that start with `verb` (INSERT, DELETE, SELECT, ...) and, when given, read or write `table` as a main table (a subquery's table does not count). */
  of(verb: string, table?: string): LoggedStatement[] {
    const pattern = new RegExp(`^${verb}\\b`, 'i')
    return this.statements.filter(({ text }) => pattern.test(text) && (!table || mainTables(text).has(table)))
  }
}

/** The tables a statement names after FROM, INTO or UPDATE outside every parenthesis. */
function mainTables(text: string): Set<string> {
  const tables = new Set<string>()
  let depth = 0
  for (const match of text.matchAll(/\(|\)|\b(?:FROM|INTO|UPDATE)\s+"?(\w+)"?/gi)) {
    if (match[0] === '(') depth += 1
    else if (match[0] === ')') depth -= 1
    else if (depth === 0 && match[1]) tables.add(match[1])
  }
  return tables
}
