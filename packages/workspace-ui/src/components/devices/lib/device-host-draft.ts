import type { SshDeviceHostConfigInput } from '@solus/contracts/device-types'

/** The SSH device host form's fields, as typed. Converted to a config for validation. */
export interface SshHostDraft {
  id: string
  label: string
  target: string
  port: string
  identityFile: string
}

export function emptySshHostDraft(): SshHostDraft {
  return { id: '', label: '', target: '', port: '', identityFile: '' }
}

/** The draft as a config to validate with `sshDeviceHostConfigSchema`. */
export function sshHostDraftConfig(draft: SshHostDraft): SshDeviceHostConfigInput {
  const config: SshDeviceHostConfigInput = {
    id: draft.id.trim(),
    label: draft.label.trim() || draft.target.trim(),
    target: draft.target.trim(),
  }
  if (draft.port.trim()) config.port = Number(draft.port.trim())
  if (draft.identityFile.trim()) config.identityFile = draft.identityFile.trim()
  return config
}
