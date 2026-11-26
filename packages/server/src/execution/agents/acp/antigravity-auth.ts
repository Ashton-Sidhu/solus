/**
 * How an Antigravity profile signs in (docs/plans/antigravity-provider.md §7).
 *
 * The environment rules and the profile settings port T3 Code (`pingdotgg/t3code`
 * commit b8ef0600, `apps/server/src/provider/antigravityAuthSupport.ts`):
 *
 *   MIT License. Copyright (c) 2026 T3 Tools Inc.
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions: The above copyright
 *   notice and this permission notice shall be included in all copies or
 *   substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
 *   WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { solusDir } from '../../../platform/paths'
import type { ProcessUser } from '../../../cli-env'
import { applyMemberFiles } from '../../seats/member-files'

/** The folder beside `GEMINI_HOME` that `agy acp` keeps its own state in. The CLI joins it under the profile. */
export const ANTIGRAVITY_APP_DATA_DIR = 'antigravity-acp'
/** Where a Google sign-in is kept when `agy` uses file storage. */
export const ANTIGRAVITY_TOKEN_FILE = join(ANTIGRAVITY_APP_DATA_DIR, 'acp_token.json')
/** Solus's record of how the profile signs in, with any key the person pasted. Never in `settings.json`. */
export const ANTIGRAVITY_SIGN_IN_FILE = 'solus-sign-in.json'
/** Vertex AI Application Default Credentials the person pasted. */
export const ANTIGRAVITY_ADC_FILE = 'solus-application-default-credentials.json'

export const ANTIGRAVITY_AUTH_METHODS = ['oauth-personal', 'oauth-business', 'gemini-api-key', 'agent-platform'] as const
export type AntigravityAuthMethod = (typeof ANTIGRAVITY_AUTH_METHODS)[number]

const signInRecordSchema = z.object({
  method: z.enum(ANTIGRAVITY_AUTH_METHODS),
  apiKey: z.string().min(1).optional(),
  gcpProject: z.string().min(1).optional(),
  gcpLocation: z.string().min(1).optional(),
  /** When agy accepted a Google or Gemini Enterprise sign-in: agy keeps those where Solus cannot see them (the macOS keychain). */
  verifiedAt: z.number().optional(),
})
/** How a profile signs in: what Solus keeps in `ANTIGRAVITY_SIGN_IN_FILE`. */
export type AntigravityAuth = z.infer<typeof signInRecordSchema>

/** The host login's Antigravity profile: `agy`'s own default profile keeps a Google sign-in in the OS keyring, which a remote sign-in cannot reach. */
export function hostAntigravityProfile(): string {
  return join(solusDir(), 'agents', 'agy', 'profile')
}

/** How a profile signs in: its record, else a Google account. */
export function antigravityAuthOf(profile: string): AntigravityAuth {
  try {
    const record = signInRecordSchema.safeParse(JSON.parse(readFileSync(join(profile, ANTIGRAVITY_SIGN_IN_FILE), 'utf8')))
    if (record.success) return record.data
  } catch {
    // No record: the profile signs in with a Google account.
  }
  return { method: 'oauth-personal' }
}

/** The record's file content. The seat manager writes it as the seat's own user. */
export function antigravitySignInRecord(auth: AntigravityAuth): string {
  return `${JSON.stringify(signInRecordSchema.parse(auth))}\n`
}

/** Whether a profile holds a sign-in that agy can use, for the method it signs in with. */
export function antigravitySignedIn(profile: string, auth = antigravityAuthOf(profile)): boolean {
  switch (auth.method) {
    case 'oauth-personal':
    case 'oauth-business': return auth.verifiedAt !== undefined || existsSync(join(profile, ANTIGRAVITY_TOKEN_FILE))
    case 'gemini-api-key': return !!auth.apiKey
    case 'agent-platform': return !!auth.apiKey || existsSync(join(profile, ANTIGRAVITY_ADC_FILE))
  }
}

// Inherited credentials and switches that would let the host's own Google
// configuration answer for this profile.
const REMOVED_ENVIRONMENT = new Set([
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_QUOTA_PROJECT',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GCLOUD_PROJECT',
  'CLOUDSDK_CORE_PROJECT',
  'AGY_ACP_CCPA_PROJECT',
  'AGY_ACP_ENABLE_OAUTH',
  'GEMINI_HOME',
  'AGY_ACP_FORCE_FILE_STORAGE',
  'AGY_CLI_DISABLE_AUTO_UPDATE',
  'BROWSER',
  'PYTHONUNBUFFERED',
  'ELECTRON_RUN_AS_NODE',
  // An inherited pipe whose owner exited makes Electron-as-Node print Crashpad errors to stderr.
  'CHROME_CRASHPAD_PIPE_NAME',
])

/** The environment of an `agy` process for one profile. */
export function antigravityEnvironment(base: NodeJS.ProcessEnv, profile: string, auth: AntigravityAuth): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(base)) {
    // Windows reads environment names without case: remove every spelling.
    if (!REMOVED_ENVIRONMENT.has(name.toUpperCase())) env[name] = value
  }
  // The Google Cloud project and location go in `settings.json`: GOOGLE_API_KEY would win over them here.
  if (auth.method === 'gemini-api-key' && auth.apiKey) env.GEMINI_API_KEY = auth.apiKey
  if (auth.method === 'agent-platform') {
    if (auth.apiKey) env.GOOGLE_API_KEY = auth.apiKey
    else if (existsSync(join(profile, ANTIGRAVITY_ADC_FILE))) env.GOOGLE_APPLICATION_CREDENTIALS = join(profile, ANTIGRAVITY_ADC_FILE)
  }
  // agy 1.5 keeps a Google sign-in in one OS keyring entry for every profile
  // unless it believes it runs over SSH; then it uses the profile's file.
  if (auth.method === 'oauth-personal') env.SSH_CONNECTION = base.SSH_CONNECTION || '127.0.0.1 0 127.0.0.1 0'
  env.GEMINI_HOME = profile
  env.AGY_ACP_FORCE_FILE_STORAGE = '1'
  // agy's troubleshooting guide names "true"; the CLI keeps updating itself with "1".
  env.AGY_CLI_DISABLE_AUTO_UPDATE = 'true'
  env.PYTHONUNBUFFERED = '1'
  // With no display, a sign-in prints its link instead of opening a browser on the host.
  delete env.DISPLAY
  delete env.WAYLAND_DISPLAY
  return env
}

/** agy's `settings.json` in a profile: the sign-in method and its Google Cloud project. */
interface AntigravitySettings {
  auth: { type: AntigravityAuthMethod }
  gcp?: { project?: string; location?: string }
}

/**
 * Makes the profile folder and writes agy's `settings.json`: the sign-in method,
 * so that agy's own sign-out clears only that method's credential, and the
 * Google Cloud project and location of Gemini Enterprise and Vertex AI. The file
 * holds no credential.
 */
export function prepareAntigravityProfile(profile: string, auth: Pick<AntigravityAuth, 'method' | 'gcpProject' | 'gcpLocation'>, user: ProcessUser | null = null): void {
  const appData = join(profile, ANTIGRAVITY_APP_DATA_DIR)
  const settings: AntigravitySettings = { auth: { type: auth.method } }
  if (auth.gcpProject || auth.gcpLocation) {
    settings.gcp = {}
    if (auth.gcpProject) settings.gcp.project = auth.gcpProject
    if (auth.gcpLocation) settings.gcp.location = auth.gcpLocation
  }
  const content = `${JSON.stringify(settings)}\n`
  if (user) {
    // Where each member is their own OS user, the host object made the profile as theirs, and agy runs as them.
    applyMemberFiles(user, [{ kind: 'folder', path: appData, mode: 0o700 }, { kind: 'write', path: join(appData, 'settings.json'), content, mode: 0o600 }])
    return
  }
  if (!existsSync(appData)) mkdirSync(appData, { recursive: true, mode: 0o700 })
  chmodSync(profile, 0o700)
  writeFileSync(join(appData, 'settings.json'), content, { mode: 0o600 })
}
