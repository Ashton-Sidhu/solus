// Reads a human name out of a SCIP symbol string when the producer did not
// emit `display_name`. Symbol grammar (scip.proto, "Symbol"):
//   <scheme> ' ' <manager> ' ' <package-name> ' ' <version> ' ' <descriptors>
// and each descriptor ends in one of `/` `#` `.` `:` `!` `()` `(name)` `[name]`,
// with backticks escaping names that contain those characters.

const LOCAL_PREFIX = 'local '

export function isLocalSymbol(symbol: string): boolean {
  return symbol.startsWith(LOCAL_PREFIX)
}

/** The descriptor suffix of a symbol, e.g. "`math.ts`/Counter#increment()." */
function descriptorsOf(symbol: string): string {
  if (isLocalSymbol(symbol)) return ''
  // Package names and versions never contain spaces except as separators; the
  // first four space-separated parts are scheme, manager, package, version.
  let cursor = 0
  for (let part = 0; part < 4; part++) {
    const next = symbol.indexOf(' ', cursor)
    if (next === -1) return ''
    cursor = next + 1
  }
  return symbol.slice(cursor)
}

interface LastDescriptor {
  /** Where the final descriptor begins, so the caller can read the one before it. */
  start: number
  name: string
}

function lastDescriptorOf(descriptors: string): LastDescriptor | null {
  if (!descriptors) return null
  let end = descriptors.length
  // Strip the terminator of the last descriptor.
  if (descriptors.endsWith('().')) end -= 3
  else if (descriptors.endsWith(')') || descriptors.endsWith(']')) {
    const open = descriptors.endsWith(')') ? '(' : '['
    const start = descriptors.lastIndexOf(open)
    if (start === -1) return null
    return { start, name: unescapeName(descriptors.slice(start + 1, end - 1)) }
  } else end -= 1
  // Walk back to the previous terminator, skipping over backtick-escaped names.
  let start = end
  let inEscape = false
  while (start > 0) {
    const char = descriptors[start - 1]!
    if (char === '`') inEscape = !inEscape
    else if (!inEscape && (char === '/' || char === '#' || char === '.' || char === ':' || char === '!' || char === ')' || char === ']')) break
    start--
  }
  return { start, name: unescapeName(descriptors.slice(start, end)) }
}

/** The last descriptor's name: `increment` for "...Counter#increment().",
 *  `a` for "...add().(a)", `T` for "...map()[T]". */
export function symbolDisplayName(symbol: string): string {
  return lastDescriptorOf(descriptorsOf(symbol))?.name ?? ''
}

/** The name of the descriptor that owns the last one: `Array` for
 *  "...`lib.es5.d.ts`/Array#map().". Empty when the last descriptor sits at the
 *  top level of its file, because a file is not an owner a reader would name. */
export function symbolOwnerName(symbol: string): string {
  const descriptors = descriptorsOf(symbol)
  const last = lastDescriptorOf(descriptors)
  if (!last || last.start === 0) return ''
  const owner = lastDescriptorOf(descriptors.slice(0, last.start))
  if (!owner || /\.d?\.?ts$/.test(owner.name)) return ''
  return owner.name
}

function unescapeName(name: string): string {
  if (name.length >= 2 && name.startsWith('`') && name.endsWith('`')) {
    return name.slice(1, -1).replaceAll('``', '`')
  }
  return name
}
