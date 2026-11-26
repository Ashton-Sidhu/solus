import { parseFlags } from '@solus/contracts/entrypoint'
import type { AppAccess } from '@solus/contracts/host-api'
import { OUTSIDE_APP_GUIDES } from '@solus/contracts/outside-apps'
import { readCloudMachineRecord } from './cloud-machine'
import { requireRunningServerUrl, withLocalRpc } from './local-rpc'
import { defaultDataDir, runtimePaths } from './runtime'

/**
 * `solus mcp`: how outside apps reach this server's tools (docs/outside-apps.md),
 * for a host with no screen. The commands use the local socket, which admits the
 * person at this machine as the host owner (`local-rpc.ts`), as `solus host approve`
 * does: the same RPCs as the Use Solus in other apps section of the app.
 */

export type McpCommand =
  | { kind: 'addresses'; dataDir: string }
  | { kind: 'code'; dataDir: string; access: AppAccess }

interface AppEndpoint { localUrl: string; publicUrl: string | null }
interface AppPairingCode { code: string; access: AppAccess; expiresAt: number }

const USAGE = 'Usage: solus mcp [--data-dir PATH]\n       solus mcp code [--access read|write|full] [--data-dir PATH]'
const ACCESS_LABELS: Record<AppAccess, string> = { read: 'Read', write: 'Read and write', full: 'Full' }
const CLOUD_CODE = 'A cloud host has no owner, so this command makes no pairing code here. A member of its organization makes one in their Solus client: Use Solus in other apps, then Make pairing code.'

export function parseMcpCommand(args: string[]): McpCommand {
  const [first, ...rest] = args
  const isCode = first === 'code'
  if (first && !isCode && !first.startsWith('-')) throw new Error(`Unknown mcp command: ${first}\n${USAGE}`)
  let dataDir = defaultDataDir()
  let access: AppAccess = 'write'
  parseFlags(isCode ? rest : args, {
    '--data-dir': { value: (value) => { dataDir = value } },
    ...(isCode ? {
      '--access': { value: (value) => {
        if (value !== 'read' && value !== 'write' && value !== 'full') throw new Error('--access requires read, write, or full')
        access = value
      } },
    } : {}),
  }, (arg) => new Error(`Unknown mcp option: ${arg}\n${USAGE}`))
  return isCode ? { kind: 'code', dataDir, access } : { kind: 'addresses', dataDir }
}

/** The setup commands of an app that runs in a terminal, from its guide in the app picker. */
function terminalCommands(guideId: 'claude-code' | 'codex', url: string): readonly string[] {
  const handoff = OUTSIDE_APP_GUIDES.find((guide) => guide.id === guideId)?.handoff
  return handoff?.kind === 'commands' ? handoff.commands(url) : []
}

/** The MCP addresses and the commands that connect Claude Code and Codex. `memberCodes`: on a cloud host, members make the codes. */
export function addressLines(endpoint: AppEndpoint, memberCodes = false): string[] {
  // A browser on another computer opens the sign-in page, so the commands use the public address when there is one.
  const url = endpoint.publicUrl ?? endpoint.localUrl
  return [
    'Use Solus in other apps (MCP)',
    ...(memberCodes ? [] : [`  On this computer: ${endpoint.localUrl}`]),
    `  From anywhere:    ${endpoint.publicUrl ?? 'none. Run `solus connect` to get a public address.'}`,
    '',
    'Claude Code:',
    ...terminalCommands('claude-code', url).map((line) => `  ${line}`),
    'Codex:',
    ...terminalCommands('codex', url).map((line) => `  ${line}`),
    '',
    memberCodes
      ? 'The app opens a sign-in page. A member of the organization approves it with a pairing code from their Solus client: Use Solus in other apps, then Make pairing code.'
      : 'The app opens a sign-in page. Approve it with a pairing code from `solus mcp code`, or in the Solus app.',
    'On a machine with no browser, add --no-browser to the login command. It prints the sign-in address: open it in a browser on another computer, then paste back the address that browser goes to.',
  ]
}

export function codeLines(code: AppPairingCode, now = Date.now()): string[] {
  const minutes = Math.max(0, Math.round((code.expiresAt - now) / 60_000))
  return [
    `Pairing code: ${code.code}`,
    `  Access:  ${ACCESS_LABELS[code.access]}`,
    `  Expires: in ${minutes} minutes`,
    'Type it on the app\'s sign-in page. It works once. Run `solus mcp code` for a new one.',
  ]
}

export async function runMcpCommand(args: string[], log: (line: string) => void): Promise<void> {
  const command = parseMcpCommand(args)
  // A cloud host trusts no local connection: what the command line can say comes from its records.
  const cloudMachine = readCloudMachineRecord(command.dataDir)
  if (cloudMachine) {
    if (command.kind === 'code') throw new Error(CLOUD_CODE)
    const publicUrl = cloudMachine.tunnel ? `https://${cloudMachine.tunnel.hostname}/mcp` : null
    for (const line of addressLines({ localUrl: '', publicUrl }, true)) log(line)
    return
  }
  const serverUrl = requireRunningServerUrl(runtimePaths(command.dataDir))
  const lines = command.kind === 'code'
    ? codeLines(await withLocalRpc<AppPairingCode>(serverUrl, (call) => call('connectionsCreateAppPairingCode', [{ access: command.access }])))
    : addressLines(await withLocalRpc<AppEndpoint>(serverUrl, (call) => call('connectionsAppEndpoint')))
  for (const line of lines) log(line)
}
