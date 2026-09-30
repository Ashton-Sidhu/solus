import type { TurnRefusal } from '@solus/contracts/organization-scope'

/**
 * Why the organization model refused a turn (organization-scope §3.1;
 * organization-vms §4). The transport sends the code to the client, which keeps
 * the draft and says why; it imports nothing heavier than this.
 */
export class TurnRefusedError extends Error {
  constructor(readonly code: TurnRefusal, message: string) {
    super(message)
    this.name = 'TurnRefusedError'
  }
}
