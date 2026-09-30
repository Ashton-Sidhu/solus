import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { z } from 'zod'
import {
  AGENT_PROFILE_ENTRIES,
  AGENT_PROFILE_MAX_FILE_BYTES,
  AGENT_PROFILE_MAX_TOTAL_BYTES,
  agentProfileSkipSchema,
  type AgentProfileBundle,
  type AgentProfileFile,
  type AgentProfileSkip,
  type AgentProfileStatus,
} from '@solus/contracts/agent-profile'
import { SEAT_PROVIDERS, type SeatProvider } from '@solus/contracts/seats'
import { hostClaudeDir, hostCodexHome } from './seat-login'

/**
 * A person's agent profile (docs/agent-profile.md): read from the provider homes
 * of the machine they work on, written into their seat on a host several people
 * use. Only the entries in `AGENT_PROFILE_ENTRIES` move, so a login, a setting,
 * or a transcript never leaves either side.
 */

/** Written into each seat home, so the next copy removes what it no longer holds. */
const MANIFEST_FILE = '.solus-profile.json'
/** A directory tree deeper than this is not a skill. */
const MAX_DEPTH = 8
const SKIPPED_DIRECTORIES = new Set(['node_modules'])

const manifestSchema = z.object({
  syncedAt: z.number(),
  files: z.array(z.string()),
  skipped: z.array(agentProfileSkipSchema),
})
type Manifest = z.infer<typeof manifestSchema>

/** The homes each provider's profile is read from, first one wins a path. The
 *  shared `~/.agents/skills` is where the skills CLI installs for Codex. */
export function hostProfileHomes(provider: SeatProvider): string[] {
  return provider === 'claude-code' ? [hostClaudeDir()] : [hostCodexHome(), join(homedir(), '.agents')]
}

/**
 * Whose homes a copy goes into: a member's seats on a shared host, or the
 * owner's own homes on a host they own that is not the machine the copy came
 * from, such as their personal VM. The owner's turns run on the host login, so
 * that is where their agent looks.
 */
export type AgentProfileTarget = { kind: 'member'; userId: string } | { kind: 'owner' }

export interface AgentProfileDeps {
  /** The homes this machine's profile is read from, per provider; first one wins a path. */
  sourceHomes: (provider: SeatProvider) => string[]
  /** The target's home for a provider (`SeatStore.homeFor`). */
  homeFor: (target: AgentProfileTarget, provider: SeatProvider) => string
  now: () => number
}

/** One provider's part of a checked bundle, decoded and ready to write. */
interface ProviderWrite {
  provider: SeatProvider
  home: string
  files: { path: string; content: Buffer; executable: boolean }[]
  /** Paths the source reported but could not send: a copy already here stays. */
  skipped: Set<string>
  /** On an owner's host, the host's own files a copy left in place. */
  kept: AgentProfileSkip[]
}

/**
 * Owns the agent profile files in members' seat homes. The copy is one way and
 * repeatable: every path, size, and link is checked before anything changes, the
 * manifest is written last, and an I/O failure part way is repaired by the next
 * copy. There is no staging or rollback.
 */
export class AgentProfileManager {
  constructor(private readonly deps: AgentProfileDeps) {}

  /** This machine's profile, within the size limits; what does not fit is reported. */
  read(): AgentProfileBundle {
    return readProfile(this.deps.sourceHomes)
  }

  /**
   * Replace the profile in the target's homes with `bundle`: files it no longer
   * holds are removed, the rest written. Anything else in a home — the login, the
   * transcript link, what the person made there — is left alone.
   */
  apply(target: AgentProfileTarget, bundle: AgentProfileBundle): AgentProfileStatus {
    const writes = this.check(target, bundle)
    const syncedAt = this.deps.now()
    for (const { provider, home, files, skipped, kept: keptOnHost } of writes) {
      const previous = readManifest(home)?.files.filter((path) => isProfilePath(provider, path)) ?? []
      const kept = new Set(files.map((file) => file.path))
      const retained = previous.filter((path) => !kept.has(path) && skipped.has(path))
      for (const stale of previous) {
        if (kept.has(stale) || skipped.has(stale)) continue
        rmSync(join(home, stale), { force: true })
        removeEmptyParents(home, stale)
      }
      for (const file of files) {
        const target = join(home, file.path)
        const mode = file.executable ? 0o700 : 0o600
        try {
          mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
          writeFileSync(target, file.content, { mode })
          // `mode` above applies only to a new file.
          chmodSync(target, mode)
        } catch (error) {
          throw new Error(`Could not copy "${file.path}" into your seat: ${error instanceof Error ? error.message : String(error)}. Copy again to finish.`)
        }
      }
      const manifestPath = join(home, MANIFEST_FILE)
      if (kept.size === 0 && retained.length === 0) {
        rmSync(manifestPath, { force: true })
        continue
      }
      const manifest: Manifest = {
        syncedAt,
        files: [...kept, ...retained],
        skipped: [...bundle.skipped.filter((skip) => skip.provider === provider), ...keptOnHost],
      }
      writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 })
    }
    return this.status(target)
  }

  /** Remove every profile file this host copied into the target's homes. */
  remove(target: AgentProfileTarget): AgentProfileStatus {
    return this.apply(target, { files: [], skipped: [] })
  }

  status(target: AgentProfileTarget): AgentProfileStatus {
    const manifests = SEAT_PROVIDERS.map((provider) => readManifest(this.deps.homeFor(target, provider))).filter((manifest) => manifest !== null)
    if (manifests.length === 0) return { syncedAt: null, fileCount: 0, skipped: [] }
    return {
      syncedAt: Math.max(...manifests.map((manifest) => manifest.syncedAt)),
      fileCount: manifests.reduce((count, manifest) => count + manifest.files.length, 0),
      skipped: manifests.flatMap((manifest) => manifest.skipped),
    }
  }

  /** Every refusal, before the first change: the bundle comes over the network. */
  private check(target: AgentProfileTarget, bundle: AgentProfileBundle): ProviderWrite[] {
    let totalBytes = 0
    const writes = SEAT_PROVIDERS.map((provider): ProviderWrite => ({
      provider,
      home: resolvedHome(this.deps.homeFor(target, provider)),
      files: [],
      skipped: new Set(bundle.skipped.filter((skip) => skip.provider === provider).map((skip) => skip.path)),
      kept: [],
    }))
    for (const file of bundle.files) {
      if (!isProfilePath(file.provider, file.path)) throw new Error(`"${file.path}" is not part of an agent profile.`)
      const write = writes.find((each) => each.provider === file.provider)!
      if (write.files.some((each) => each.path === file.path)) throw new Error(`"${file.path}" is in the profile twice.`)
      const content = Buffer.from(file.contentBase64, 'base64')
      if (content.length > AGENT_PROFILE_MAX_FILE_BYTES) throw new Error(`"${file.path}" is larger than an agent profile file may be.`)
      totalBytes += content.length
      if (totalBytes > AGENT_PROFILE_MAX_TOTAL_BYTES) throw new Error('The agent profile is larger than a host accepts.')
      write.files.push({ path: file.path, content, executable: file.executable === true })
    }
    // An owner's homes are theirs to arrange: a copy never replaces a file, or
    // follows a link, it did not put there itself. The same rule keeps a copy
    // aimed at the machine it came from from changing anything.
    if (target.kind === 'owner') for (const write of writes) keepHostFiles(write)
    for (const { home, files, provider } of writes) {
      const paths = new Set(files.map((file) => file.path))
      for (const path of paths) {
        const folder = [...ancestorsOf(path)].find((ancestor) => paths.has(ancestor))
        if (folder) throw new Error(`"${folder}" is both a file and a folder in the profile.`)
        refuseLinks(home, path)
      }
      for (const stale of readManifest(home)?.files ?? []) if (isProfilePath(provider, stale)) refuseLinks(home, stale)
    }
    return writes
  }
}

/** The profile in `homesFor`, within the size limits; what does not fit is reported. */
function readProfile(homesFor: (provider: SeatProvider) => string[]): AgentProfileBundle {
  const files: AgentProfileFile[] = []
  const skipped: AgentProfileSkip[] = []
  let totalBytes = 0
  for (const provider of SEAT_PROVIDERS) {
    const taken = new Set<string>()
    for (const [index, home] of homesFor(provider).entries()) {
      for (const entry of AGENT_PROFILE_ENTRIES[provider]) {
        // A home after the first contributes skills alone.
        if (index > 0 && entry !== 'skills') continue
        walk(join(home, entry), entry, 0, new Set(), (path, absolutePath) => {
          if (taken.has(path) || !isProfilePath(provider, path)) return
          taken.add(path)
          let size: number
          let mode: number
          try {
            ({ size, mode } = statSync(absolutePath))
          } catch {
            skipped.push({ provider, path, reason: 'unreadable' })
            return
          }
          if (size > AGENT_PROFILE_MAX_FILE_BYTES) return void skipped.push({ provider, path, reason: 'file-too-large' })
          if (totalBytes + size > AGENT_PROFILE_MAX_TOTAL_BYTES) return void skipped.push({ provider, path, reason: 'profile-too-large' })
          let content: Buffer
          try {
            content = readFileSync(absolutePath)
          } catch {
            skipped.push({ provider, path, reason: 'unreadable' })
            return
          }
          totalBytes += size
          const file: AgentProfileFile = { provider, path, contentBase64: content.toString('base64') }
          if (mode & 0o111) file.executable = true
          files.push(file)
        })
      }
    }
  }
  return { files, skipped }
}

/** Every file under `absolutePath`, through links (the skills CLI links skills in), never into a hidden name or a loop. */
function walk(
  absolutePath: string,
  path: string,
  depth: number,
  visited: Set<string>,
  onFile: (path: string, absolutePath: string) => void,
): void {
  let stats: ReturnType<typeof statSync>
  try {
    stats = statSync(absolutePath)
  } catch {
    return
  }
  if (stats.isFile()) return onFile(path, absolutePath)
  if (!stats.isDirectory() || depth >= MAX_DEPTH) return
  const real = realpathSync(absolutePath)
  if (visited.has(real)) return
  visited.add(real)
  let names: string[]
  try {
    names = readdirSync(absolutePath).sort()
  } catch {
    return
  }
  for (const name of names) {
    if (name.startsWith('.') || SKIPPED_DIRECTORIES.has(name)) continue
    walk(join(absolutePath, name), `${path}/${name}`, depth + 1, visited, onFile)
  }
}

/** A profile path is relative, has no hidden or parent segment, and starts at one of its provider's entries. */
export function isProfilePath(provider: SeatProvider, path: string): boolean {
  if (path.includes('\\') || path.includes('\0') || posix.isAbsolute(path)) return false
  const segments = path.split('/')
  if (segments.some((segment) => !segment || segment === '..' || segment.startsWith('.'))) return false
  if (posix.normalize(path) !== path) return false
  const [entry] = segments
  const entries: readonly string[] = AGENT_PROFILE_ENTRIES[provider]
  if (!entries.includes(entry)) return false
  // An instruction file is one file, not a folder.
  return entry.endsWith('.md') ? segments.length === 1 : segments.length > 1
}

function readManifest(home: string): Manifest | null {
  const path = join(home, MANIFEST_FILE)
  if (!existsSync(path)) return null
  try {
    return manifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

/** Remove the folders a deleted file leaves empty, up to its profile entry. */
function removeEmptyParents(home: string, path: string): void {
  const segments = path.split('/')
  for (let depth = segments.length - 1; depth > 1; depth--) {
    try {
      rmdirSync(join(home, ...segments.slice(0, depth)))
    } catch {
      return
    }
  }
}

function resolvedHome(home: string): string {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  return realpathSync(home)
}

/** Move each file the host holds of its own out of `write`, into `kept`. */
function keepHostFiles(write: ProviderWrite): void {
  const owned = new Set(readManifest(write.home)?.files ?? [])
  write.files = write.files.filter((file) => {
    if (owned.has(file.path)) return true
    const onPath = [file.path, ...ancestorsOf(file.path)]
    const held = onPath.some((path) => {
      try {
        const stats = lstatSync(join(write.home, path))
        return path === file.path || stats.isSymbolicLink()
      } catch {
        return false
      }
    })
    if (held) write.kept.push({ provider: write.provider, path: file.path, reason: 'kept-on-host' })
    return !held
  })
}

/** `skills/a/b/SKILL.md` → `skills/a/b`, `skills/a`, `skills`. */
function* ancestorsOf(path: string): Generator<string> {
  const segments = path.split('/')
  for (let depth = segments.length - 1; depth > 0; depth--) yield segments.slice(0, depth).join('/')
}

/**
 * Refuse a path that passes through a link already in the seat: a write or a
 * removal there would land outside the member's home. The home itself may be
 * a link; it was resolved before this check.
 */
function refuseLinks(home: string, path: string): void {
  const segments = path.split('/')
  for (let depth = 1; depth <= segments.length; depth++) {
    let isLink: boolean
    try {
      isLink = lstatSync(join(home, ...segments.slice(0, depth))).isSymbolicLink()
    } catch {
      return
    }
    if (isLink) throw new Error(`"${segments.slice(0, depth).join('/')}" in your seat is a link, so the profile is not copied through it.`)
  }
}
