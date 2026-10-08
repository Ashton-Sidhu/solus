import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { userKey } from '@solus/contracts/user'
import { ActingIdentities, useActingIdentities, type ActingIdentitiesDeps } from '@solus/server/execution/seats/acting-identity'

/**
 * The acting identities a booted server installs (plans/019-acting-identity.md),
 * for a test that acts for members without booting one. Each member's home is a
 * folder under a temporary directory; nobody has GitHub unless the test says so.
 */
export function installTestIdentities(deps: Partial<ActingIdentitiesDeps> = {}): ActingIdentities {
  const homes = mkdtempSync(join(tmpdir(), 'solus-test-homes-'))
  const identities = new ActingIdentities({
    memberToken: async () => null,
    fetchLogin: async () => 'member',
    memberHome: (seat) => join(homes, userKey(seat.userId)),
    gitHelper: () => null,
    now: Date.now,
    ...deps,
  })
  useActingIdentities(identities)
  return identities
}
