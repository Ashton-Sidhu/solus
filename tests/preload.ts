import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A test run is a development runtime started from the repo root, so its logger
// would truncate the running dev server's `dev.log` and write fixture entries
// into it. Every test process, and every child it spawns, logs here instead.
process.env.SOLUS_DEV_LOG ??= join(mkdtempSync(join(tmpdir(), 'solus-test-log-')), 'dev.log')
