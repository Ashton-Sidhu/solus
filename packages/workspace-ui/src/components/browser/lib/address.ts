/**
 * The address, split so the host reads first.
 *
 * A browser address is nearly all boilerplate — `http://localhost:` on every one
 * of them — and the part that differs is the port and the route. Muting the
 * scheme and the path is what makes the differing part the thing the eye lands
 * on, without truncating anything away.
 */
export interface AddressParts {
  /** `http://`, including the separator, or empty when the address has none. */
  scheme: string
  /** `localhost:5173`. The whole address when it will not parse as one. */
  host: string
  /** `/pricing?ref=1`, or empty when the address did not parse. */
  path: string
  /** Served over TLS, which is the only thing the lock glyph may claim. */
  secure: boolean
}

export function addressParts(url: string): AddressParts {
  // A half-typed address is ordinary while the field is being edited, and it
  // still has to render as something. `URL` is no help on its own here:
  // `localhost:51` parses happily, as a `localhost:` scheme with a path of
  // `51`. Only the two schemes a browser page can actually be served over count
  // as a parsed address.
  const unparsed: AddressParts = { scheme: '', host: url, path: '', secure: false }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return unparsed
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return unparsed
  return {
    scheme: `${parsed.protocol}//`,
    host: parsed.host,
    path: `${parsed.pathname}${parsed.search}${parsed.hash}`,
    secure: parsed.protocol === 'https:',
  }
}
