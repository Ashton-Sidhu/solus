/**
 * A Gemini Enterprise sign-in for one Antigravity profile
 * (docs/plans/antigravity-provider.md §7). agy runs as an ACP agent, and its
 * `authenticate` opens Google with a redirect to a listener on the host. Solus
 * gives the person the link; they bring back the address their browser ended
 * on, which a browser on another device cannot reach, and Solus delivers it to
 * the listener on the host.
 *
 * The link and callback checks port T3 Code (`pingdotgg/t3code` commit b8ef0600,
 * `apps/server/src/provider/antigravityAuthSupport.ts` and `antigravityCallback.ts`):
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
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { launchedProcess, type LaunchOptions } from '../../cli-env'
import { resolveHomePath } from '../../platform/paths'
import { AcpConnection, methodNotFound } from '../agents/acp/acp-connection'
import { ACP_PROTOCOL_VERSION } from '../agents/acp/acp-protocol'
import { ANTIGRAVITY_COMMAND, antigravityArgs } from '../agents/acp/antigravity'
import { antigravityEnvironment, prepareAntigravityProfile } from '../agents/acp/antigravity-auth'

/** What the `BROWSER` helper prints before the link (`seat-manager.ts`, `ensureSeatShims`). */
export const ANTIGRAVITY_BROWSER_MARKER = '__SOLUS_AGY_AUTH_URL__'
const MAX_URL_LENGTH = 16_384
const LINK_TIMEOUT_MS = 60_000
const FORWARD_TIMEOUT_MS = 10_000

export interface EnterpriseSignInOptions {
  profile: string
  gcpProject: string
  gcpLocation: string
  launch: LaunchOptions
  /** The helper agy runs as its browser: it prints the link instead of opening one. */
  browserHelper: string
  /** The folder whose `open` and `xdg-open` fail, first on the PATH. */
  shimBin: string
  spawnProcess?: (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess
  /** Delivers the browser's redirect to agy's listener; a plain GET by default. */
  forward?: (callback: URL) => Promise<void>
}

/** agy answered `authenticate` without a browser: the profile already holds a Gemini Enterprise sign-in. */
export class EnterpriseAlreadySignedIn extends Error {
  constructor() {
    super('Google Antigravity is already signed in to Gemini Enterprise.')
    this.name = 'EnterpriseAlreadySignedIn'
  }
}

export interface EnterpriseSignIn {
  verificationUrl: string
  /** The address the person's browser ended on. Throws when it does not answer this sign-in. */
  submit(value: string): Promise<void>
  cancel(): void
  /** Resolves when agy accepted the sign-in; rejects with the reason it did not. */
  done: Promise<void>
}

interface PendingLink { authorizationUrl: string; redirectUri: string; state: string }

/** Google's link with a loopback redirect, or null for anything else. */
export function parseEnterpriseLink(value: string): PendingLink | null {
  if (value.length > MAX_URL_LENGTH || /\s/.test(value)) return null
  const url = URL.parse(value)
  if (!url) return null
  const state = url.searchParams.get('state')
  const redirectUri = url.searchParams.get('redirect_uri')
  if (
    url.origin !== 'https://accounts.google.com'
    || url.pathname !== '/o/oauth2/v2/auth'
    || url.username || url.password || url.hash
    || url.searchParams.getAll('state').length !== 1
    || url.searchParams.getAll('redirect_uri').length !== 1
    || url.searchParams.get('response_type') !== 'code'
    || !state || state.length > 512 || /\s/.test(state)
    || !redirectUri || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/.test(redirectUri)
  ) return null
  if (Number(new URL(redirectUri).port) < 1024) return null
  return { authorizationUrl: value, redirectUri, state }
}

/** Google answers with one code or one error, never both. */
function hasOneAnswer(params: URLSearchParams): boolean {
  const codes = params.getAll('code')
  const errors = params.getAll('error')
  return (codes.length === 1 && !!codes[0] && errors.length === 0) || (errors.length === 1 && !!errors[0] && codes.length === 0)
}

/** The pasted address, when it is Google's answer to this sign-in and nothing else. */
export function enterpriseCallbackOf(pending: PendingLink, value: string): URL {
  const callback = URL.parse(value.trim())
  const invalid = 'Paste the whole address of the page your browser ended on after you signed in.'
  if (!callback || value.length > MAX_URL_LENGTH) throw new Error(invalid)
  const expected = new URL(pending.redirectUri)
  if (
    callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1'
    || callback.origin !== expected.origin || callback.pathname !== expected.pathname
    || callback.username || callback.password || callback.hash
  ) throw new Error('This address does not belong to the current sign-in.')
  const states = callback.searchParams.getAll('state')
  if (states.length !== 1 || states[0] !== pending.state) throw new Error('This address does not belong to the current sign-in.')
  if (!hasOneAnswer(callback.searchParams)) throw new Error(invalid)
  const issuers = callback.searchParams.getAll('iss')
  if (issuers.length > 1 || (issuers.length === 1 && issuers[0] !== 'https://accounts.google.com')) throw new Error('This address is not a Google sign-in answer.')
  return callback
}

/** One GET to agy's listener, with no proxy and no redirect. */
function forwardToListener(callback: URL): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = () => reject(new Error('Solus could not deliver the sign-in to Google Antigravity. Start the sign-in again.'))
    const outgoing = httpRequest({ protocol: 'http:', hostname: callback.hostname, port: callback.port, path: `${callback.pathname}${callback.search}`, method: 'GET', agent: false }, (incoming) => {
      incoming.once('error', failed)
      incoming.once('end', () => {
        const status = incoming.statusCode ?? 0
        if (status >= 200 && status < 300) resolve()
        else failed()
      })
      incoming.resume()
    })
    outgoing.setTimeout(FORWARD_TIMEOUT_MS, () => { outgoing.destroy(); failed() })
    outgoing.once('error', failed)
    outgoing.end()
  })
}

export async function startEnterpriseSignIn(options: EnterpriseSignInOptions): Promise<EnterpriseSignIn> {
  const auth = { method: 'oauth-business' as const, gcpProject: options.gcpProject, gcpLocation: options.gcpLocation }
  prepareAntigravityProfile(options.profile, auth)
  const env = antigravityEnvironment(options.launch.env, options.profile, auth)
  env.BROWSER = options.browserHelper
  env.PATH = `${options.shimBin}:${env.PATH ?? ''}`
  const run = launchedProcess({ ...options.launch, env }, ANTIGRAVITY_COMMAND, antigravityArgs(options.profile))
  const spawn = options.spawnProcess ?? ((file, args, spawnOptions) => nodeSpawn(file, args, { ...spawnOptions, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }))
  const child = spawn(run.file, run.args, { cwd: resolveHomePath(options.profile), env: run.env })

  let resolveLink!: (link: PendingLink) => void
  const link = new Promise<PendingLink>((resolve) => { resolveLink = resolve })
  const connection = new AcpConnection({ stdin: child.stdin!, stdout: child.stdout!, stderr: child.stderr }, {
    onNotification: () => {},
    onRequest: async (method) => { throw methodNotFound(method) },
    onStderrLine: (line) => {
      if (!line.startsWith(ANTIGRAVITY_BROWSER_MARKER)) return
      const parsed = parseEnterpriseLink(line.slice(ANTIGRAVITY_BROWSER_MARKER.length).trim())
      if (parsed) resolveLink(parsed)
    },
  })
  const stop = () => {
    connection.close('The sign-in ended.')
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
  child.once('exit', (code, signal) => connection.close(`Google Antigravity exited (${signal ?? `code ${code}`}) before the sign-in finished.`))
  child.once('error', (error) => connection.close(`Google Antigravity could not start: ${error.message}`))

  try {
    await connection.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'solus', title: 'Solus', version: '1.0.0' },
    })
  } catch (error) {
    stop()
    throw error
  }
  const done = connection.request('authenticate', { methodId: 'oauth-business' }).then(() => undefined).finally(stop)
  void done.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  const noLink = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Google Antigravity did not print a Gemini Enterprise sign-in link.')), LINK_TIMEOUT_MS)
    timer.unref?.()
  })
  let pending: PendingLink
  try {
    pending = await Promise.race([link, noLink, done.then((): never => { throw new EnterpriseAlreadySignedIn() })])
  } catch (error) {
    stop()
    throw error
  } finally {
    clearTimeout(timer)
  }
  const forward = options.forward ?? forwardToListener
  return {
    verificationUrl: pending.authorizationUrl,
    submit: (value) => forward(enterpriseCallbackOf(pending, value)),
    cancel: stop,
    done,
  }
}
