import { randomBytes } from 'node:crypto'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const MAX_TIMESTAMP = 0xffffffffffff

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

  const random = randomBytes(10)
  let randomness = 0n
  for (const byte of random) randomness = (randomness << 8n) | BigInt(byte)

  return encode(BigInt(timestamp), 10) + encode(randomness, 16)
}
