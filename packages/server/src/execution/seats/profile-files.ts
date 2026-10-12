import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import {
  AGENT_PROFILE_ENTRIES,
  AGENT_PROFILE_MAX_FILE_BYTES,
  AGENT_PROFILE_MAX_TOTAL_BYTES,
  type AgentProfileFileEntry,
  type AgentProfileSkip,
} from '@solus/contracts/agent-profile'
import { SEAT_PROVIDERS, type SeatProvider } from '@solus/contracts/seats'

/**
 * The file part of an agent profile (plans/020-agent-profile.md §2): the
 * instruction files, subagents, commands, prompts, and hand-written skills in
 * a provider home. Read from the homes of the machine a person works on,
 * written into their seats on another host. Every path, size, and link is
 * checked before anything changes; an I/O failure part way is repaired by the
 * next copy. There is no staging or rollback. `AgentProfileManager` owns the
 * manifest; this module takes what the manifest held and answers what it holds now.
 */

/** A directory tree deeper than this is not a skill. */
const MAX_DEPTH = 8
const SKIPPED_DIRECTORIES = new Set(['node_modules'])

/** One provider's part of a checked copy, decoded and ready to write. */
export interface ProviderFileWrite {
  provider: SeatProvider
  home: string
  files: { path: string; content: Buffer; executable: boolean }[]
  /** Paths the source reported but could not send: a copy already here stays. */
  skipped: Set<string>
  /** On an owner's host, the host's own files a copy left in place. */
  kept: AgentProfileSkip[]
  /** The paths an earlier copy put in this home. */
  previous: string[]
}

export function sha256Hex(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/** What a read of the homes found: the files that fit, and what did not. */
export interface ProfileFilesRead {
  files: AgentProfileFileEntry[]
  skipped: AgentProfileSkip[]
}

/**
 * The files in the homes `homesFor` names (first one wins a path), within the
 * size limits; what does not fit is reported. A folder under `skills/` named in
 * `registrySkills` is a registry install, carried as a reference, so its files
 * are not read.
 */
export function readProfileFiles(homesFor: (provider: SeatProvider) => string[], registrySkills: ReadonlySet<string>): ProfileFilesRead {
  const files: AgentProfileFileEntry[] = []
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
          if (entry === 'skills' && registrySkills.has(path.split('/')[1] ?? '')) return
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
          const file: AgentProfileFileEntry = { kind: 'file', provider, path, contentBase64: content.toString('base64'), hash: sha256Hex(content) }
          if (mode & 0o111) file.executable = true
          files.push(file)
        })
      }
    }
  }
  return { files, skipped }
}

/**
 * Every refusal, before the first change: the entries come over the network.
 * `ownerHost`: the homes are the owner's own, so a file the host already has is
 * kept, never replaced.
 */
export function planProfileFiles(options: {
  entries: AgentProfileFileEntry[]
  skipped: AgentProfileSkip[]
  homeFor: (provider: SeatProvider) => string
  previousFor: (provider: SeatProvider) => string[]
  ownerHost: boolean
}): ProviderFileWrite[] {
  let totalBytes = 0
  const writes = SEAT_PROVIDERS.map((provider): ProviderFileWrite => ({
    provider,
    home: resolvedHome(options.homeFor(provider)),
    files: [],
    skipped: new Set(options.skipped.filter((skip) => skip.provider === provider).map((skip) => skip.path)),
    kept: [],
    previous: options.previousFor(provider).filter((path) => isProfilePath(provider, path)),
  }))
  for (const file of options.entries) {
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
  if (options.ownerHost) for (const write of writes) keepHostFiles(write)
  for (const { home, files, previous } of writes) {
    const paths = new Set(files.map((file) => file.path))
    for (const path of paths) {
      const folder = [...ancestorsOf(path)].find((ancestor) => paths.has(ancestor))
      if (folder) throw new Error(`"${folder}" is both a file and a folder in the profile.`)
      refuseLinks(home, path)
    }
    for (const stale of previous) refuseLinks(home, stale)
  }
  return writes
}

/**
 * Write one provider's planned files: files the profile no longer holds are
 * removed, the rest written. Anything else in the home — the login, the
 * transcript link, what the person made there — is left alone. Answers the
 * paths this copy now owns in the home.
 */
export function writeProfileFiles(write: ProviderFileWrite): string[] {
  const { home, files, skipped, previous } = write
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
  return [...kept, ...retained]
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

export function resolvedHome(home: string): string {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  return realpathSync(home)
}

/** Move each file the host holds of its own out of `write`, into `kept`. */
function keepHostFiles(write: ProviderFileWrite): void {
  const owned = new Set(write.previous)
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
