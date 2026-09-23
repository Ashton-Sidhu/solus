/**
 * ULIDs, minted the same way on every side of the wire.
 *
 * The server mints record ids with this, and a client mints the id of a task it
 * is about to create, so the row it shows before the server answers already
 * carries the id the task will have (docs/plans/sidebar-motion.md, step 1). It
 * uses Web Crypto, which the server, the desktop renderer, and the web client
 * all provide.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const MAX_TIMESTAMP = 0xffffffffffff
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/

function encode(value: bigint, length: number): string {
  let encoded = ''
  for (let index = 0; index < length; index++) {
    encoded = CROCKFORD[Number(value & 31n)] + encoded
    value >>= 5n
  }
  return encoded
}

/**
 * Generate a canonical 26-character ULID: a 48-bit millisecond timestamp
 * followed by 80 bits of cryptographic randomness. Passing the timestamp is
 * useful for deterministic tests; production callers use the current time.
 */
export function ulid(timestamp = Date.now()): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > MAX_TIMESTAMP) {
    throw new RangeError('ULID timestamp must be an integer between 0 and 281474976710655.')
  }

  const random = crypto.getRandomValues(new Uint8Array(10))
  let randomness = 0n
  for (const byte of random) randomness = (randomness << 8n) | BigInt(byte)

  return encode(BigInt(timestamp), 10) + encode(randomness, 16)
}

/** A canonical ULID: 26 Crockford characters, uppercase, within the 48-bit
 *  timestamp range. Used to check an id a client minted before storing it. */
export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value)
}
