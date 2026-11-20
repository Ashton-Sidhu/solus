import type { SolusServer } from '../server'
import { KeyConnections } from '../../vault/key-connections'

export function registerVaultHandlers(server: SolusServer): void {
  const connections = new KeyConnections()
  server.register('vaultKeyStatus', ([ref]) => connections.status(ref))
  server.register('vaultKeySave', ([input]) => connections.save(input))
  server.register('vaultKeyDisconnect', ([ref]) => connections.disconnect(ref))
}
