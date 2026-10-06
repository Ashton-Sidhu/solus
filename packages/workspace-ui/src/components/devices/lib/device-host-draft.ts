import type { SshDeviceHostConfigInput } from '@solus/contracts/device-types'

/** The SSH device host form's fields, as typed. Converted to a config for validation. */
export interface SshHostDraft {
  label: string
  target: string
  port: string
  identityFile: string
}

export function emptySshHostDraft(): SshHostDraft {
  return { label: '', target: '', port: '', identityFile: '' }
}

/** The draft as a config to validate with `sshDeviceHostConfigSchema`. The id
 *  comes from the name, so it never takes the id of a host that exists. */
export function sshHostDraftConfig(draft: SshHostDraft, takenIds: readonly string[]): SshDeviceHostConfigInput {
  const label = draft.label.trim() || draft.target.trim()
  const config: SshDeviceHostConfigInput = { id: sshHostIdFor(label, takenIds), label, target: draft.target.trim() }
  if (draft.port.trim()) config.port = Number(draft.port.trim())
  if (draft.identityFile.trim()) config.identityFile = draft.identityFile.trim()
  return config
}

/** A host id for a new SSH device host, from its name: lowercase words joined
 *  with dashes, and a number suffix when the id is taken. */
function sshHostIdFor(name: string, takenIds: readonly string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56).replace(/-+$/, '') || 'device-host'
  const root = base === 'local' ? 'local-host' : base
  let id = root
  for (let suffix = 2; takenIds.includes(id); suffix++) id = `${root}-${suffix}`
  return id
}
