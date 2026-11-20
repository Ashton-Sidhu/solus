import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { actAsHostForTests } from '../../../packages/server/src/execution/seats/acting-identity'
import { ServerDiscovery } from '../../../packages/server/src/host/running-servers/discovery'
import { loadProjectConfig, saveProjectConfig } from '../../../packages/server/src/project-config/project-config'

actAsHostForTests()
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'solus-running-server-checkouts-')))
try {
  const nested = join(repo, 'nested-checkout')
  mkdirSync(join(repo, 'api'), { recursive: true })
  mkdirSync(join(nested, 'api'), { recursive: true })
  execFileSync('git', ['init', '-q', '.'], { cwd: repo })
  execFileSync('git', ['init', '-q', '.'], { cwd: nested })
  const paths = [join(repo, 'api'), join(nested, 'api')]
  assert.deepEqual(await new ServerDiscovery().checkoutRoots(paths), [{ path: paths[0], root: repo }, { path: paths[1], root: nested }])
  const serverUrls = ['https://localhost:3000/admin?api=v1#health']
  await saveProjectConfig(paths[0], { version: 1, serverUrls })
  assert.deepEqual((await loadProjectConfig(repo))?.serverUrls, serverUrls)
} finally {
  rmSync(repo, { recursive: true, force: true })
}
