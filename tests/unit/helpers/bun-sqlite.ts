import { Database } from 'bun:sqlite'

type Prepared = ReturnType<Database['prepare']>

/**
 * `node:sqlite`'s `DatabaseSync` for a Bun that has none:
 * `mock.module('node:sqlite', () => ({ DatabaseSync }))`. Its `close()`
 * releases the file at once, as Node's does. Bun's default `close()` keeps the
 * file open, and Windows refuses to delete an open file, so every test that
 * removed its data folder failed there with EBUSY. Bun refuses a strict close
 * while a statement lives, so the statements this connection handed out are
 * finalized first.
 */
export class DatabaseSync extends Database {
  readonly #statements = new Set<Prepared>()

  /** Node spells the read-only option `readOnly`; Bun refuses that spelling. */
  constructor(path: string, options?: { readOnly?: boolean }) {
    super(path, options?.readOnly ? { readonly: true } : undefined)
  }

  prepare(...args: Parameters<Database['prepare']>): Prepared {
    const statement = super.prepare(...args)
    this.#statements.add(statement)
    return statement
  }

  close(): void {
    for (const statement of this.#statements) statement.finalize()
    this.#statements.clear()
    super.close(true)
  }
}
