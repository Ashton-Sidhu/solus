import { resolve } from 'path'
import { buildHeadless } from './package-server'

// Uses the same source bundles and migrations as the packaged server.
const output = resolve(import.meta.dir, '../dist/headless')

buildHeadless(output).then(() => {
  console.log(`Built server and CLI in ${output}`)
}).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
