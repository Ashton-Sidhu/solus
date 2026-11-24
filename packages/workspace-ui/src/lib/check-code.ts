import { formatCheckCode } from '@solus/contracts/add-machine'

/**
 * A new check code for an approval request (docs/plans/add-machine-card.md): the
 * requester makes it and shows it at once, and the target's owner compares it.
 */
export function newCheckCode(random: (values: Uint32Array) => Uint32Array = (values) => crypto.getRandomValues(values)): string {
  // The alphabet has 32 characters, a divisor of 2^32, so the remainder is uniform.
  return formatCheckCode((n) => random(new Uint32Array(1))[0] % n)
}
