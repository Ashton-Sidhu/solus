import {
  agentProfileKeyOf,
  type AgentProfile,
  type AgentProfileEntry,
  type AgentProfileFileEntry,
  type AgentProfileIntegrationEntry,
  type AgentProfileKey,
  type AgentProfileSkillEntry,
  type AgentProfileStatus,
} from '@solus/contracts/agent-profile'
import { integrationSlug, type IntegrationProbeResult } from '@solus/contracts/integration-types'
import type { SeatProvider } from '@solus/contracts/seats'
import type { RemoteSkill } from '@solus/contracts/types'
import { urlHost } from '../integrations'

/**
 * The agent profile as the phone shows and edits it (plans/020-agent-profile.md
 * §1, §3): the entries by part, the instruction file of each provider as text,
 * and the one entry each add makes. A phone has no provider home, so a file
 * entry is made here, hashed as the host hashes it.
 */

/** The instruction file each provider reads from its home. */
export const INSTRUCTION_FILES = {
  'claude-code': 'CLAUDE.md',
  codex: 'AGENTS.md',
} as const satisfies Record<SeatProvider, string>

export const PROVIDER_LABELS = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
} as const satisfies Record<SeatProvider, string>

export const SEAT_PROVIDERS: readonly SeatProvider[] = ['claude-code', 'codex']

// ─── Bytes ───

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function encodeBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += BASE64_ALPHABET[(triple >> 18) & 63]! + BASE64_ALPHABET[(triple >> 12) & 63]!
    out += b === undefined ? '=' : BASE64_ALPHABET[(triple >> 6) & 63]!
    out += c === undefined ? '=' : BASE64_ALPHABET[triple & 63]!
  }
  return out
}

export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '')
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let written = 0
  for (let i = 0; i < clean.length; i += 4) {
    const chunk = [0, 1, 2, 3].map((offset) => BASE64_ALPHABET.indexOf(clean[i + offset] ?? 'A'))
    const triple = (chunk[0]! << 18) | (chunk[1]! << 12) | (chunk[2]! << 6) | chunk[3]!
    const count = Math.min(3, clean.length - i - 1)
    for (let n = 0; n < count; n += 1) bytes[written++] = (triple >> (16 - n * 8)) & 255
  }
  return bytes.subarray(0, written)
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotr = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits))

/**
 * SHA-256 of the bytes, hex, as the host computes a file entry's hash. Hermes
 * has no Web Crypto and the app has no native crypto module, so this is the
 * one implementation the phone uses; a file entry is small (1 MB at most).
 */
export function sha256Hex(bytes: Uint8Array): string {
  const bitLength = bytes.length * 8
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x1_0000_0000))
  view.setUint32(padded.length - 4, bitLength >>> 0)
  const state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const words = new Uint32Array(64)
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(words[i - 15]!, 7) ^ rotr(words[i - 15]!, 18) ^ (words[i - 15]! >>> 3)
      const s1 = rotr(words[i - 2]!, 17) ^ rotr(words[i - 2]!, 19) ^ (words[i - 2]! >>> 10)
      words[i] = (words[i - 16]! + s0 + words[i - 7]! + s1) >>> 0
    }
    let a = state[0]!
    let b = state[1]!
    let c = state[2]!
    let d = state[3]!
    let e = state[4]!
    let f = state[5]!
    let g = state[6]!
    let h = state[7]!
    for (let i = 0; i < 64; i += 1) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[i]! + words[i]!) >>> 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    state[0] += a
    state[1] += b
    state[2] += c
    state[3] += d
    state[4] += e
    state[5] += f
    state[6] += g
    state[7] += h
  }
  return Array.from(state, (word) => word.toString(16).padStart(8, '0')).join('')
}

// ─── Entries ───

/** A file entry for `text` at `path` in the provider's home, hashed as the host hashes it. */
export function fileEntryFromText(provider: SeatProvider, path: string, text: string): AgentProfileFileEntry {
  const bytes = new TextEncoder().encode(text)
  return { kind: 'file', provider, path, contentBase64: encodeBase64(bytes), hash: sha256Hex(bytes) }
}

/** The text of a file entry; the person edits this and the entry is made again from it. */
export function fileEntryText(entry: AgentProfileFileEntry): string {
  return new TextDecoder().decode(decodeBase64(entry.contentBase64))
}

export function isInstructionFile(entry: AgentProfileFileEntry): boolean {
  return entry.path === INSTRUCTION_FILES[entry.provider]
}

export function instructionKey(provider: SeatProvider): AgentProfileKey {
  return `file:${provider}/${INSTRUCTION_FILES[provider]}`
}

/** A registry skill as the host installs it: `skills add <source>@<skillId>`. */
export function skillEntryFromRemote(skill: RemoteSkill): AgentProfileSkillEntry {
  return { kind: 'skill', name: skill.name, source: skill.repo, skillId: skill.name }
}

/** The record a probed server becomes: named after its host, with the auth the probe found. Null when the probe could not place it. */
export function integrationEntryFromProbe(url: string, probe: IntegrationProbeResult): AgentProfileIntegrationEntry | null {
  if (probe.outcome === 'undetermined') return null
  const name = urlHost(url.trim())
  return { kind: 'integration', slug: integrationSlug(name), name, url: url.trim(), auth: probe.auth }
}

/** A hand-written skill: the files under `skills/<name>/` of one provider. */
export interface HandWrittenSkill {
  name: string
  provider: SeatProvider
  keys: AgentProfileKey[]
}

export interface AgentProfileParts {
  /** Files that are not a skill's, by provider: the instruction file first. */
  files: AgentProfileFileEntry[]
  handWrittenSkills: HandWrittenSkill[]
  registrySkills: AgentProfileSkillEntry[]
  integrations: AgentProfileIntegrationEntry[]
}

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name)

export function agentProfileParts(entries: AgentProfile): AgentProfileParts {
  const files: AgentProfileFileEntry[] = []
  const skillsByFolder = new Map<string, HandWrittenSkill>()
  const registrySkills: AgentProfileSkillEntry[] = []
  const integrations: AgentProfileIntegrationEntry[] = []
  for (const entry of Object.values(entries)) {
    if (entry.kind === 'skill') registrySkills.push(entry)
    else if (entry.kind === 'integration') integrations.push(entry)
    else if (entry.path.startsWith('skills/')) {
      const name = entry.path.split('/')[1] ?? ''
      const id = `${entry.provider}/${name}`
      const skill = skillsByFolder.get(id) ?? { name, provider: entry.provider, keys: [] }
      skill.keys.push(agentProfileKeyOf(entry))
      skillsByFolder.set(id, skill)
    } else files.push(entry)
  }
  files.sort((a, b) => {
    if (a.provider !== b.provider) return SEAT_PROVIDERS.indexOf(a.provider) - SEAT_PROVIDERS.indexOf(b.provider)
    return Number(isInstructionFile(b)) - Number(isInstructionFile(a)) || a.path.localeCompare(b.path)
  })
  return {
    files,
    handWrittenSkills: [...skillsByFolder.values()].sort(byName),
    registrySkills: registrySkills.sort(byName),
    integrations: integrations.sort(byName),
  }
}

// ─── Words ───

/** `file:claude-code/CLAUDE.md` → "CLAUDE.md (Claude Code)"; a skill or server by its name. */
export function entryKeyLabel(key: AgentProfileKey): string {
  const file = /^file:(claude-code|codex)\/(.+)$/.exec(key)
  if (file) return `${file[2]} (${PROVIDER_LABELS[file[1] === 'codex' ? 'codex' : 'claude-code']})`
  if (key.startsWith('skill:')) return `Skill ${key.slice('skill:'.length)}`
  return `MCP server ${key.slice('integration:'.length)}`
}

/** One side of a conflict, short enough for a note. */
export function entryValueText(document: AgentProfile, key: AgentProfileKey): string {
  const entry: AgentProfileEntry | undefined = document[key]
  if (!entry) return 'Removed'
  switch (entry.kind) {
    case 'file': {
      const text = fileEntryText(entry).replace(/\s+/g, ' ').trim()
      return text.length === 0 ? 'Empty' : text.length > 60 ? `${text.slice(0, 57)}…` : text
    }
    case 'skill':
      return `${entry.source}@${entry.skillId}`
    case 'integration':
      return `${entry.name}, ${urlHost(entry.url)}, ${AUTH_LABELS[entry.auth.kind]}`
  }
}

export const AUTH_LABELS = {
  none: 'No sign-in',
  bearer: 'API key',
  oauth: 'OAuth sign-in',
} as const satisfies Record<AgentProfileIntegrationEntry['auth']['kind'], string>

/** `3 files, 2 skills, 1 MCP server`; the parts that are zero are left out. */
export function agentProfileCounts(counts: AgentProfileStatus['counts']): string {
  const parts = [
    counts.files > 0 ? `${counts.files} ${counts.files === 1 ? 'file' : 'files'}` : null,
    counts.skills > 0 ? `${counts.skills} ${counts.skills === 1 ? 'skill' : 'skills'}` : null,
    counts.integrations > 0 ? `${counts.integrations} ${counts.integrations === 1 ? 'MCP server' : 'MCP servers'}` : null,
  ].filter((part) => part !== null)
  return parts.length ? parts.join(', ') : 'nothing'
}

/** The line under a host: where its copy came from and what it holds, or why the last call failed. */
export function hostProfileText(status: AgentProfileStatus | null, error: string | null, formatTime: (epochMs: number) => string): string {
  if (error) return error
  if (!status) return 'Not read yet.'
  if (status.syncedAt === null) return 'Not on this host yet.'
  const from = status.source === 'account' ? 'from your account' : 'from your computer'
  const keptOnHost = status.skipped.filter((skip) => skip.reason === 'kept-on-host').length
  const failed = status.skipped.filter((skip) => skip.reason === 'install-failed').length
  const notSent = status.skipped.length - keptOnHost - failed
  const kept = keptOnHost > 0 ? ` ${keptOnHost} kept as this host already had them.` : ''
  const installs = failed > 0 ? ` ${failed} ${failed === 1 ? 'skill' : 'skills'} could not be installed.` : ''
  const skipped = notSent > 0 ? ` ${notSent} left out: over the size limit or unreadable.` : ''
  return `Copied ${from} ${formatTime(status.syncedAt)}: ${agentProfileCounts(status.counts)}.${kept}${installs}${skipped}`
}

export function skillFileCountText(count: number): string {
  return count === 1 ? '1 file' : `${count} files`
}
