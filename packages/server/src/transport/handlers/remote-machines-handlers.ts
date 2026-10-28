import { z } from 'zod'
import type { HostEventMap } from '@solus/contracts/host-events'
import type { SshAddLink, SshAddResult, WslDistroList } from '@solus/contracts/remote-machines'
import { createLogger } from '../../logger'
import type { SshClient } from '../../platform/ssh'
import type { ForwardedHosts } from '../../remote-machines/forwarded-hosts'
import type { SshProvisioner } from '../../remote-machines/ssh-provisioner'
import { formatSshTarget, parseSshTarget, resolveSshTarget } from '../../remote-machines/ssh-targets'
import { wslTarget } from '../../remote-machines/wsl'
import type { SolusServer } from '../server'

const log = createLogger('main', 'remote-machines-handlers')

/** Machines this host adds over SSH and the forwards it holds (docs/plans/host-routes.md D6, D7, D9). */
export interface RemoteMachinesDeps {
  provisioner: SshProvisioner
  forwardedHosts: ForwardedHosts
  ssh: Pick<SshClient, 'resolvesToThisMachine'>
  /** Installs into a WSL distro the release of this host's own version (docs/plans/windows.md §13.6). */
  wslProvisioner: SshProvisioner
  listWslDistros(): Promise<WslDistroList>
  broadcast<K extends 'host.sshProgress'>(topic: K, payload: HostEventMap[K]): void
}

const linkSchema = z.object({ ticket: z.string().min(1), directoryUrl: z.url() })
const discoveredSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive(),
  installationId: z.string().min(1),
  name: z.string(),
  os: z.enum(['macos', 'windows', 'linux']).optional(),
  source: z.enum(['lan', 'tailnet']),
})
const wslAddSchema = z.object({
  distro: z.string().min(1).max(256),
  deviceLabel: z.string().max(64).optional(),
  requestId: z.string().min(1).max(128),
})
const addSchema = z.object({
  sshTarget: z.string().max(512).optional(),
  discovered: discoveredSchema.optional(),
  authSecret: z.string().max(1024).optional(),
  link: linkSchema.optional(),
  deviceLabel: z.string().max(64).optional(),
  requestId: z.string().min(1).max(128),
})

export function registerRemoteMachinesHandlers(server: SolusServer, deps: RemoteMachinesDeps): void {
  server.register('hostsAddOverSsh', async ([input], ctx): Promise<SshAddResult> => {
    if (!ctx.deviceId) throw new Error('Adding a machine over SSH requires an authenticated device.')
    const request = addSchema.parse(input)
    const resolved = resolveSshTarget(request.discovered, request.sshTarget)
    if (resolved.status === 'needs-target') return resolved
    const { target } = resolved
    // A forward runs with no one to type a secret: it needs a key the agent or ssh config gives.
    if (request.authSecret && !request.link) {
      throw new Error('A machine added without your Solus account is reached through an SSH forward, which needs an SSH key. Add a key for this machine, or link it to your account.')
    }
    if (!request.link && await deps.ssh.resolvesToThisMachine(target)) throw new Error('That SSH target is this computer.')
    const outcome = await deps.provisioner.add(
      { target, authSecret: request.authSecret, link: request.link, deviceLabel: request.deviceLabel ?? 'Solus' },
      (step, message) => deps.broadcast('host.sshProgress', { requestId: request.requestId, step, message }),
    )
    if (outcome.status === 'needs-auth') return { status: 'needs-auth', sshTarget: formatSshTarget(target), message: outcome.message }
    const { host } = outcome
    if (request.link) return { status: 'linked', installationId: host.installationId, label: host.label, os: host.os }
    if (!host.session) throw new Error(`Solus could not make a session on ${host.label}.`)
    // A server found on the network is dialed there directly; only a machine SSH alone reaches needs a forward.
    if (request.discovered) return { status: 'session', installationId: host.installationId, label: host.label, os: host.os, ...host.session }
    deps.broadcast('host.sshProgress', { requestId: request.requestId, step: 'forward', message: `Opening the SSH forward to ${host.label}` })
    const forwarded = await deps.forwardedHosts.add({
      installationId: host.installationId,
      label: host.label,
      target,
      os: host.os,
      remotePort: host.remotePort,
      identityKey: host.session.identityKey,
      sessionToken: host.session.sessionToken,
      startedBySolus: host.startedBySolus,
    })
    return { status: 'forwarded', host: forwarded, sessionToken: host.session.sessionToken }
  })

  server.register('hostsListForwarded', () => deps.forwardedHosts.list())

  server.register('hostsListWslDistros', () => deps.listWslDistros())

  server.register('hostsAddWsl', async ([input], ctx): Promise<SshAddResult> => {
    if (!ctx.deviceId) throw new Error('Adding a WSL distro requires an authenticated device.')
    const request = wslAddSchema.parse(input)
    const listed = await deps.listWslDistros()
    if (listed.status !== 'ready') throw new Error(listed.message)
    if (!listed.distros.some((distro) => distro.name === request.distro)) throw new Error(`WSL has no distro named ${request.distro}.`)
    const target = wslTarget(request.distro)
    const progress = (step: Parameters<Parameters<SshProvisioner['add']>[1]>[0], message: string) => deps.broadcast('host.sshProgress', { requestId: request.requestId, step, message })
    // A distro takes the computer's name, so the distro names the host.
    const label = `${request.distro} (WSL)`
    const outcome = await deps.wslProvisioner.add({ target, deviceLabel: request.deviceLabel ?? 'Solus', label }, progress)
    if (outcome.status === 'needs-auth') throw new Error(outcome.message)
    const { host } = outcome
    if (!host.session) throw new Error(`Solus could not make a session in ${request.distro}.`)
    progress('forward', `Opening the forward to ${label}`)
    const forwarded = await deps.forwardedHosts.add({
      installationId: host.installationId,
      label,
      target,
      os: host.os,
      remotePort: host.remotePort,
      identityKey: host.session.identityKey,
      sessionToken: host.session.sessionToken,
      startedBySolus: host.startedBySolus,
    })
    return { status: 'forwarded', host: forwarded, sessionToken: host.session.sessionToken }
  })

  server.register('hostsRemoveForwarded', async ([input]) => {
    const { installationId, stopRemote } = z.object({ installationId: z.string().min(1), stopRemote: z.boolean() }).parse(input)
    const record = deps.forwardedHosts.record(installationId)
    if (record && stopRemote && record.startedBySolus && record.os) {
      // The forward goes even when the machine cannot be reached now; the service then stays there.
      await deps.provisioner.uninstallService(parseSshTarget(record.sshTarget), record.os).catch((error: Error) => {
        log.warn('forwarded_host_service_not_removed', { installationId, error: error.message })
      })
    }
    return { removed: deps.forwardedHosts.remove(installationId) }
  })

  server.register('hostsLinkForwarded', async ([input]) => {
    const { installationId, link } = z.object({ installationId: z.string().min(1), link: linkSchema }).parse(input)
    const record = deps.forwardedHosts.record(installationId)
    if (!record) throw new Error('This host does not forward to that machine.')
    const outcome = await deps.provisioner.add({ target: parseSshTarget(record.sshTarget), link: link satisfies SshAddLink, deviceLabel: 'Solus' }, () => {})
    if (outcome.status === 'needs-auth') throw new Error(outcome.message)
    deps.forwardedHosts.markLinked(installationId)
    return { linked: true as const }
  })
}
