import { LINK_CODE_ENV, MACHINE_ADDRESS_ENV } from '@solus/contracts/uplink'

/** What a machine that enrolls at boot reads from its environment (plans/034-one-cloud-machine-kind.md §3). */
export interface BootLinkCode {
  /** `<ticket>@<control plane host>`. */
  code: string
  /** The machine's own HTTPS address; null when the control plane has it, or the machine gets a tunnel. */
  address: string | null
}

let bootLinkCode: BootLinkCode | null | undefined

/**
 * The link code a compute provider or a script put in this machine's environment, read
 * once. Both variables are deleted from `process.env` on that first read: agent
 * processes inherit the environment and must never see the one-use ticket. Null on a
 * machine that a person sets up.
 */
export function readBootLinkCode(): BootLinkCode | null {
  if (bootLinkCode !== undefined) return bootLinkCode
  const code = process.env[LINK_CODE_ENV]?.trim()
  const address = process.env[MACHINE_ADDRESS_ENV]?.trim()
  delete process.env[LINK_CODE_ENV]
  delete process.env[MACHINE_ADDRESS_ENV]
  bootLinkCode = code ? { code, address: address || null } : null
  return bootLinkCode
}

/** Tests only: forget the cached environment so the next read sees the test's. */
export function resetBootLinkCodeForTests(): void {
  bootLinkCode = undefined
}
