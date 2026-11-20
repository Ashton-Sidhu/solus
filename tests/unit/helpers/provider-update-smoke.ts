import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Run with `bun tests/unit/helpers/provider-update-smoke.ts`. This uses fake
// executables and temporary packages, never an installed provider or a paid turn.
const sandbox = await mkdtemp(join(tmpdir(), 'solus-provider-update-smoke-'))
const previousLog = process.env.SOLUS_DEV_LOG
process.env.SOLUS_DEV_LOG = join(sandbox, 'dev.log')
const previousDataDir = process.env.SOLUS_DATA_DIR
process.env.SOLUS_DATA_DIR = sandbox
const { AgentSoftware } = await import('@solus/server/updates/agent-software')
const { CodexSoftwareAdapter } = await import('@solus/server/updates/codex-software-adapter')

async function fakeCodex(mode: 'healthy' | 'wrong-version' | 'refused' | 'old-protocol') {
  const binary = join(sandbox, 'codex')
  const version = mode === 'wrong-version' ? '0.169.0' : '0.170.0'
  const userAgent = mode === 'old-protocol' ? 'codex/0.10.0 (test)' : 'codex/0.170.0 (test)'
  const script = [
    '#!/usr/bin/env node',
    'if (process.argv.includes("--version")) { console.log("codex-cli ' + version + '"); process.exit(0) }',
    'if (!process.env.CODEX_HOME.includes("solus-agent-health-")) process.exit(9)',
    'if (["CODEX_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OTEL_EXPORTER_OTLP_HEADERS", "NODE_OPTIONS"].some((name) => process.env[name])) process.exit(7)',
    'const readline = require("node:readline").createInterface({ input: process.stdin });',
    'readline.on("line", (line) => {',
    '  const request = JSON.parse(line);',
    '  if (request.method !== "initialize" || !request.params.capabilities.experimentalApi) process.exit(8);',
    mode === 'refused' ? 'process.exit(1);' : 'console.log(JSON.stringify({ id: request.id, result: { userAgent: ' + JSON.stringify(userAgent) + ' } }));',
    '});',
  ].join('\n')
  await writeFile(binary, script, { mode: 0o755 })
  return binary
}

async function fixture(mode: 'healthy' | 'wrong-version' | 'refused' | 'old-protocol') {
  const packageRoot = join(sandbox, 'package-' + mode)
  await mkdir(join(packageRoot, 'bin'), { recursive: true })
  await mkdir(join(packageRoot, 'codex-path'), { recursive: true })
  await writeFile(join(packageRoot, 'bin', 'codex'), await readFile(await fakeCodex(mode)))
  await writeFile(join(packageRoot, 'bin', 'codex-code-mode-host'), 'companion')
  await writeFile(join(packageRoot, 'codex-path', 'rg'), 'search')
  const archive = join(sandbox, mode + '.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', packageRoot, '.'])
  const payload = { bytes: await readFile(archive) }
  const root = join(sandbox, 'installation-' + mode)
  const software = new AgentSoftware(new CodexSoftwareAdapter({
    platform: 'linux',
    arch: 'x64',
    metadata: async () => JSON.stringify({ tag_name: 'rust-v0.170.0', assets: [{ name: 'codex-package-x86_64-unknown-linux-musl.tar.gz', digest: 'sha256:' + createHash('sha256').update(payload.bytes).digest('hex') }] }),
  }), {
    root,
    existingBinary: () => null,
    download: async (_url, path) => { await writeFile(path, payload.bytes) },
  })
  return { software, root, packageRoot, archive, payload }
}

try {
  const healthy = await fixture('healthy')
  await healthy.software.install()
  const wrong = await fixture('wrong-version')
  await assert.rejects(wrong.software.install(), /did not report version/)
  const refused = await fixture('refused')
  await assert.rejects(refused.software.install(), /exited before initialization/)
  const old = await fixture('old-protocol')
  await assert.rejects(old.software.install(), /does not work with this Solus/)
  console.log('PASS isolated version and app-server health checks through AgentSoftware.install')

  const binary = healthy.software.status.installation!.path!
  assert.equal(await readFile(join(binary, '..', '..', 'codex-path', 'rg'), 'utf8'), 'search')
  assert.equal(await readFile(join(binary, '..', 'codex-code-mode-host'), 'utf8'), 'companion')
  const selected = await readFile(join(healthy.root, 'current.json'), 'utf8')
  console.log('PASS complete Codex package extraction and activation')

  await symlink(healthy.root, join(healthy.packageRoot, 'escape'))
  execFileSync('tar', ['-czf', healthy.archive, '-C', healthy.packageRoot, '.'])
  healthy.payload.bytes = await readFile(healthy.archive)
  await assert.rejects(healthy.software.install(), /link or special file/)
  assert.equal(await readFile(join(healthy.root, 'current.json'), 'utf8'), selected)
  console.log('PASS archive links refused without changing the selected package')
} finally {
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  if (previousLog === undefined) delete process.env.SOLUS_DEV_LOG
  else process.env.SOLUS_DEV_LOG = previousLog
  await rm(sandbox, { recursive: true, force: true })
}
