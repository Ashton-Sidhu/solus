import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { createLogger } from '../logger'

const log = createLogger('main', 'server-settings')

const SOLUS_DIR = process.env.SOLUS_DATA_DIR || join(homedir(), '.solus')
const SETTINGS_FILE = join(SOLUS_DIR, 'server-settings.json')

export interface ServerSettings {
  remoteAccess: boolean
  name?: string
}

const DEFAULT_SETTINGS: ServerSettings = {
  remoteAccess: false,
}

let _settings: ServerSettings | null = null

export function getServerSettings(): ServerSettings {
  if (_settings) return _settings
  if (!existsSync(SOLUS_DIR)) mkdirSync(SOLUS_DIR, { recursive: true })

  if (existsSync(SETTINGS_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'))
      _settings = {
        remoteAccess: parsed?.remoteAccess === true,
        name: normalizeServerName(parsed?.name),
      }
      return _settings
    } catch (err) {
      log.warn(`failed to load server settings: ${err}`)
    }
  }

  _settings = { ...DEFAULT_SETTINGS }
  return _settings
}

export function setRemoteAccess(remoteAccess: boolean): ServerSettings {
  _settings = { ...getServerSettings(), remoteAccess }
  if (!existsSync(SOLUS_DIR)) mkdirSync(SOLUS_DIR, { recursive: true })
  writeFileSync(SETTINGS_FILE, JSON.stringify(_settings, null, 2), { mode: 0o600 })
  return _settings
}

export function setServerName(name: string): ServerSettings {
  const normalized = normalizeServerName(name)
  if (!normalized) throw new Error('Server name cannot be empty.')
  _settings = { ...getServerSettings(), name: normalized }
  if (!existsSync(SOLUS_DIR)) mkdirSync(SOLUS_DIR, { recursive: true })
  writeFileSync(SETTINGS_FILE, JSON.stringify(_settings, null, 2), { mode: 0o600 })
  return _settings
}

function normalizeServerName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().replace(/\s+/g, ' ')
  return trimmed ? trimmed.slice(0, 80) : undefined
}
