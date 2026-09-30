import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { solusApiOpenApi } from '../packages/contracts/src/solus-api/openapi'
const path = resolve(import.meta.dir, '../docs/api/openapi.json')
const content = JSON.stringify(solusApiOpenApi(), null, 2) + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== content) throw new Error('Workspace OpenAPI is stale. Run bun scripts/generate-solus-api.ts.')
} else writeFileSync(path, content)
