import { SOLUS_API_AUDIENCE } from '@solus/contracts/uplink'

interface SolusApiSettings { serviceId: string; signingKey?: Buffer }
interface SolusApiEnvironment { SOLUS_API_SIGNING_KEY?: string; SOLUS_API_SERVICE_ID?: string }
/** Replicas share this key and audience so renewed credentials and cursors can reach any replica. */
export function solusApiSettings(workspace: boolean, installationId: string, env: SolusApiEnvironment = process.env): SolusApiSettings {
  const serviceId = workspace ? env.SOLUS_API_SERVICE_ID ?? SOLUS_API_AUDIENCE : installationId
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(serviceId)) throw new Error('SOLUS_API_SERVICE_ID must be a stable service identifier.')
  const encoded = env.SOLUS_API_SIGNING_KEY
  if (!encoded) {
    if (workspace) throw new Error('The Solus API needs SOLUS_API_SIGNING_KEY: a base64-encoded key of at least 32 bytes, shared by service replicas.')
    return { serviceId }
  }
  const signingKey = Buffer.from(encoded, 'base64')
  if (signingKey.length < 32 || signingKey.toString('base64') !== encoded) throw new Error('SOLUS_API_SIGNING_KEY must contain at least 32 random bytes encoded as base64.')
  return { serviceId, signingKey }
}
