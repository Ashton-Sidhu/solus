import { X509Certificate } from 'node:crypto'
import type { DeviceSigningTeam } from '@solus/contracts/device-types'
import type { DeviceCommandRunner } from './device-process'

/**
 * Apple signing for builds that go on an iPhone or iPad. Every app on a
 * device must be signed. xcodebuild signs automatically with
 * `-allowProvisioningUpdates` once it knows the team, so Solus finds the
 * teams in this Mac's signing certificates and puts one in the command.
 */

const MAX_IDENTITIES = 10

/** Identity names from `security find-identity -v -p codesigning`, Apple's only. */
export function parseSigningIdentities(stdout: string): string[] {
  const names = new Set<string>()
  for (const match of stdout.matchAll(/^\s*\d+\)\s+[0-9A-F]{40}\s+"([^"]+)"/gm)) {
    if (/^(Apple Development|Apple Distribution|iPhone Developer|iPhone Distribution|Developer ID Application):/.test(match[1]!)) names.add(match[1]!)
  }
  return [...names].slice(0, MAX_IDENTITIES)
}

/** The team a certificate belongs to: its OU is the team id, its O the team name. */
export function signingTeamOf(pem: string): DeviceSigningTeam | null {
  let subject: string
  try {
    subject = new X509Certificate(pem).subject
  } catch {
    return null
  }
  const field = (key: string) => subject.split('\n').find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1).trim()
  const teamId = field('OU')
  if (!teamId || !/^[A-Z0-9]{10}$/.test(teamId)) return null
  return { teamId, name: (field('O') ?? teamId).slice(0, 120) }
}

/** The teams this Mac can sign for. None when it has no Apple certificate yet, or is not a Mac. */
export async function discoverSigningTeams(run: DeviceCommandRunner): Promise<DeviceSigningTeam[]> {
  if (process.platform !== 'darwin') return []
  const identities = await run('security', ['find-identity', '-v', '-p', 'codesigning'], { timeoutMs: 10_000 })
  if (identities.code !== 0) return []
  const teams = new Map<string, DeviceSigningTeam>()
  for (const name of parseSigningIdentities(identities.stdout)) {
    const certificate = await run('security', ['find-certificate', '-c', name, '-p'], { timeoutMs: 10_000 })
    const team = certificate.code === 0 ? signingTeamOf(certificate.stdout) : null
    if (team && !teams.has(team.teamId)) teams.set(team.teamId, team)
  }
  return [...teams.values()]
}

/**
 * A failed build's signing problem in words a person can act on, read from
 * xcodebuild's log. Null when the failure is not about signing.
 */
export function explainSigningFailure(log: string): string | null {
  if (/requires a development team/i.test(log)) return 'The build needs a signing team. Choose one in the build profile under Signing team.'
  if (/No Accounts|No account for team|verify that your accounts have valid credentials/i.test(log)) return 'Xcode is not signed in to your Apple account. Add it in Xcode → Settings → Accounts, then build again.'
  if (/has no devices from which to generate a provisioning profile/i.test(log)) return 'Your team has no devices yet. Connect and pair your iPhone or iPad, then build again.'
  const entitlement = /doesn't match the entitlements file's value for the (\S+) entitlement/i.exec(log)
  if (entitlement) return `The app asks for the ${entitlement[1]} entitlement, but your team's provisioning profile does not give it. In Xcode, open Signing & Capabilities for each target and add the capability (for App Groups, tick the group), or set it on the App ID at developer.apple.com, then build again.`
  if (/No signing certificate|No profiles for/i.test(log)) return 'This Mac has no development certificate or profile for the app. Add your Apple account in Xcode → Settings → Accounts, and keep -allowProvisioningUpdates in the command.'
  return null
}
