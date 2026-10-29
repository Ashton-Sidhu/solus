import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, lstat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
  elapsedMs: number
}

export async function command(program: string, args: string[], options: {
  cwd?: string
  input?: string | Uint8Array
  env?: Partial<NodeJS.ProcessEnv>
  allowFailure?: boolean
} = {}): Promise<CommandResult> {
  const started = performance.now()
  const env = { ...process.env, ...options.env }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_TRACE') || key === 'GIT_CURL_VERBOSE') delete env[key]
  const child = spawn(program, args, { cwd: options.cwd, env, stdio: 'pipe' })
  const output: Buffer[] = []
  const errors: Buffer[] = []
  child.stdout.on('data', (part: Buffer) => output.push(part))
  child.stderr.on('data', (part: Buffer) => errors.push(part))
  child.stdin.on('error', () => {})
  child.stdin.end(options.input)
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (status) => resolve(status ?? 1))
  })
  const result = { code, stdout: Buffer.concat(output).toString(), stderr: Buffer.concat(errors).toString(), elapsedMs: performance.now() - started }
  if (code !== 0 && !options.allowFailure) throw new Error(`${program} failed (${code}): ${redact(result.stderr)}`)
  return result
}

function redact(text: string): string {
  return text.replace(/art_v1_[a-f0-9]+(?:\?expires=\d+)?/g, '[repo-token]').replace(/Bearer\s+[^\s"']+/g, 'Bearer [redacted]').replace(/https:\/\/[^\s/@]+:[^\s/@]+@/g, 'https://[redacted]@')
}

export interface GitRemote { url: string; token?: string }

export function gitEnv(remote?: GitRemote): Partial<NodeJS.ProcessEnv> {
  const env: Partial<NodeJS.ProcessEnv> = {
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Solus proof', GIT_AUTHOR_EMAIL: 'proof@example.invalid',
    GIT_COMMITTER_NAME: 'Solus proof', GIT_COMMITTER_EMAIL: 'proof@example.invalid',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '',
    GIT_CONFIG_KEY_2: 'protocol.file.allow', GIT_CONFIG_VALUE_2: 'always',
  }
  if (remote?.token) {
    env.GIT_ASKPASS = fileURLToPath(new URL('./askpass.mjs', import.meta.url))
    env.ARTIFACTS_GIT_ORIGIN = new URL(remote.url).origin
    env.ARTIFACTS_GIT_TOKEN = remote.token
  }
  return env
}

export async function git(cwd: string, args: string[], options: { input?: string; remote?: GitRemote; allowFailure?: boolean; env?: Partial<NodeJS.ProcessEnv> } = {}): Promise<CommandResult> {
  const result = await command('git', args, { cwd, input: options.input, allowFailure: true, env: { ...gitEnv(options.remote), ...options.env } })
  if (options.remote?.token) {
    const token = options.remote.token
    result.stderr = result.stderr.replaceAll(token, '[repo-token]').replaceAll(token.split('?expires=')[0]!, '[repo-token]')
  }
  if (result.code !== 0 && !options.allowFailure) throw new Error(`git failed (${result.code}): ${redact(result.stderr)}`)
  return result
}

export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export async function diskBytes(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true })
  let bytes = 0
  for (const entry of entries) {
    const child = `${path}/${entry.name}`
    if (entry.isDirectory()) bytes += await diskBytes(child)
    else bytes += (await lstat(child)).blocks * 512
  }
  return bytes
}

export interface ProofCheck { name: string; status: 'pass' | 'fail' | 'blocked'; detail?: string; elapsedMs?: number }
export class ProofReport {
  readonly checks: ProofCheck[] = []
  async check(name: string, run: () => Promise<void>): Promise<void> {
    const started = performance.now()
    try {
      await run()
      this.checks.push({ name, status: 'pass', elapsedMs: performance.now() - started })
      console.log(`PASS ${name}`)
    } catch (error) {
      const detail = redact(error instanceof Error ? error.message : String(error))
      this.checks.push({ name, status: 'fail', detail, elapsedMs: performance.now() - started })
      console.log(`FAIL ${name}: ${detail}`)
    }
  }
  blocked(name: string, detail: string): void {
    this.checks.push({ name, status: 'blocked', detail })
    console.log(`BLOCKED ${name}: ${detail}`)
  }
}

export async function initBare(path: string): Promise<GitRemote> {
  await mkdir(path, { recursive: true })
  await git(path, ['init', '--bare', '--initial-branch=main'])
  await git(path, ['config', 'uploadpack.allowFilter', 'true'])
  return { url: new URL(`file://${path}`).href }
}

/** A push can succeed remotely while its response fails. Verify each ref before retrying. */
export async function pushRefs(source: string, remote: GitRemote, kind: 'heads' | 'tags'): Promise<void> {
  const expected = (await git(source, ['for-each-ref', '--format=%(objectname) %(refname)', `refs/${kind}`])).stdout.trim().split('\n').filter(Boolean)
  for (let attempt = 0; attempt < 3; attempt++) {
    const pushed = await git(source, ['push', remote.url, kind === 'heads' ? '--all' : '--tags'], { remote, allowFailure: true })
    const actual = await git(source, ['ls-remote', remote.url, `refs/${kind}/*`], { remote, allowFailure: true })
    const refs = new Map(actual.stdout.trim().split('\n').filter(Boolean).map(line => { const [sha, ref] = line.split(/\s+/); return [ref, sha] }))
    if (actual.code === 0 && expected.every(line => { const [sha, ref] = line.split(' '); return refs.get(ref) === sha })) return
    if (pushed.code !== 0 && !/HTTP 5\d\d|unexpected disconnect|remote end hung up/i.test(pushed.stderr)) throw new Error(`Push failed (${pushed.code}); remote refs did not match`)
  }
  throw new Error('Push did not produce all expected refs after three attempts')
}
