import { parseDocument } from 'htmlparser2'

type StorageNode = ReturnType<typeof parseDocument>['children'][number]
interface TextLeaf { node: StorageNode; from: number; to: number }
interface Marker { ref: string; from: number; to: number }
interface TextBlock { text: string; leaves: TextLeaf[]; markers: Marker[] }
const blockTags = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th'])
const markerTag = 'ac:inline-comment-marker'
const failure = () => new Error('Cannot keep a Confluence inline comment attached through this edit. Keep its text range identifiable or edit this section in Confluence.')
const escapeXml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

function isElement(node: StorageNode): node is Extract<StorageNode, { name: string; children: StorageNode[] }> { return node.type === 'tag' || node.type === 'script' || node.type === 'style' }

/** Index editable text blocks without counting markup, attributes, or macro parameters as text. */
function blocks(storage: string): TextBlock[] {
  const root = parseDocument(storage, { xmlMode: false, recognizeSelfClosing: true, recognizeCDATA: true, decodeEntities: true, withStartIndices: true, withEndIndices: true })
  const result: TextBlock[] = []
  function hasBlock(node: StorageNode): boolean {
    return 'children' in node && node.children.some(child => isElement(child) && (blockTags.has(child.name) || hasBlock(child)))
  }
  function visit(node: StorageNode) {
    if (!isElement(node)) return
    if (blockTags.has(node.name) && !hasBlock(node)) {
      const block: TextBlock = { text: '', leaves: [], markers: [] }
      function collect(child: StorageNode) {
        if (child.type === 'text') {
          const from = block.text.length
          block.text += child.data
          block.leaves.push({ node: child, from, to: block.text.length })
        } else if (isElement(child)) {
          if (child.name.startsWith('ac:') && child.name !== markerTag) {
            // An image/macro is a boundary, never an editable text occurrence.
            block.text += '\uFFFC'
            return
          }
          if (child.name === 'br') { block.text += '\n'; return }
          const from = block.text.length
          for (const nested of child.children) collect(nested)
          if (child.name === markerTag) {
            const ref = child.attribs['ac:ref']
            if (!ref || from === block.text.length) throw failure()
            block.markers.push({ ref, from, to: block.text.length })
          }
        }
      }
      collect(node)
      result.push(block)
    } else {
      if (node.name === markerTag) throw failure()
      for (const child of node.children) visit(child)
    }
  }
  for (const node of root.children) visit(node)
  // Refuse an unindexed marker (e.g. one in a macro) instead of silently losing it.
  const count = (storage.match(/<ac:inline-comment-marker\b/g) ?? []).length
  if (result.reduce((sum, block) => sum + block.markers.length, 0) !== count) throw failure()
  return result
}

/** Reads do not use the strict publishing index. An unreadable marker is present
 * with an undefined quote; it must not hide the page's other discussions. */
export function confluenceMarkerQuotes(storage: string): Map<string, string | undefined> {
  const quotes = new Map<string, string | undefined>()
  const root = parseDocument(storage, { recognizeSelfClosing: true, recognizeCDATA: true, decodeEntities: true })
  function text(node: StorageNode): string | undefined {
    if (node.type === 'text') return node.data
    if (!isElement(node)) return ''
    if (node.name.startsWith('ac:') && node.name !== markerTag) return undefined
    if (node.name === 'br') return '\n'
    const parts = node.children.map(text)
    return parts.some(part => part === undefined) ? undefined : parts.join('')
  }
  function visit(node: StorageNode, inMacro = false): void {
    if (!isElement(node)) return
    const hidden = inMacro || (node.name.startsWith('ac:') && node.name !== markerTag)
    if (node.name === markerTag) {
      const ref = node.attribs['ac:ref']
      if (ref) {
        const quote = hidden ? undefined : text(node)
        const previous = quotes.get(ref)
        quotes.set(ref, !quote || (quotes.has(ref) && previous === undefined) ? undefined : (previous ?? '') + quote)
      }
    }
    for (const child of node.children) visit(child, hidden)
  }
  for (const node of root.children) visit(node)
  return quotes
}

/** Formatting can split one native marker into adjacent spans with the same ID. */
function joinedMarkers(markers: Marker[]): Marker[] {
  const byRef = new Map<string, Marker[]>()
  for (const marker of markers) {
    const ranges = byRef.get(marker.ref) ?? []
    ranges.push(marker)
    byRef.set(marker.ref, ranges)
  }
  const joined: Marker[] = []
  for (const ranges of byRef.values()) {
    let current: Marker | undefined
    for (const range of ranges.sort((a, b) => a.from - b.from)) {
      if (current && range.from <= current.to) current.to = Math.max(current.to, range.to)
      else { current = { ...range }; joined.push(current) }
    }
  }
  return joined
}

export function requireUniqueConfluenceQuote(storage: string, quote: string): void {
  const text = blocks(storage).map(block => block.text).join('\n')
  const start = text.indexOf(quote)
  if (!quote || start < 0 || text.indexOf(quote, start + 1) >= 0) {
    throw new Error('The selected text is missing or repeated in Confluence. Publish the text first, then select a unique passage to publish this comment.')
  }
}

function mapMarker(marker: Marker, before: string, after: string): Marker {
  if (before === after) return marker
  const quote = before.slice(marker.from, marker.to)
  const occurrence = after.indexOf(quote)
  if (occurrence >= 0 && after.indexOf(quote, occurrence + 1) < 0 && before.indexOf(quote) === marker.from && before.lastIndexOf(quote) === marker.from) {
    return { ...marker, from: occurrence, to: occurrence + quote.length }
  }
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  let suffix = 0
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++
  const end = before.length - suffix
  const delta = after.length - before.length
  // The single changed span must stay within the selection, or wholly outside it.
  if (prefix >= marker.to) return marker
  if (end <= marker.from) return { ...marker, from: marker.from + delta, to: marker.to + delta }
  if (prefix > marker.from && end < marker.to && marker.to + delta > marker.from) return { ...marker, to: marker.to + delta }
  throw failure()
}

function markerTargets(previous: TextBlock[], incoming: TextBlock[]): Map<TextBlock, TextBlock> {
  const targets = new Map<TextBlock, TextBlock>()
  const used = new Set<number>()
  const previousPositions = new Map<string, number[]>()
  const incomingPositions = new Map<string, number[]>()
  for (const [positions, source] of [[previousPositions, previous], [incomingPositions, incoming]] as const) {
    source.forEach((block, index) => {
      const indexes = positions.get(block.text) ?? []
      indexes.push(index)
      positions.set(block.text, indexes)
    })
  }
  // Reserve ALL unchanged blocks, including ones without comments. If one has
  // moved, position alone cannot identify a changed marked block.
  const stablePositions = previous.length === incoming.length && [...previousPositions].every(([text, indexes]) => {
    const nextIndexes = incomingPositions.get(text)
    return !nextIndexes || (indexes.length === nextIndexes.length && indexes.every((index, item) => index === nextIndexes[item]))
  })
  for (let index = 0; index < previous.length; index++) {
    const before = previous[index]!
    if (!before.markers.length) continue
    const exact = incomingPositions.get(before.text) ?? []
    const target = exact.length === 1 && previousPositions.get(before.text)!.length === 1 ? exact[0]!
      : stablePositions && exact.length === 0 && !previousPositions.has(incoming[index]!.text) ? index : -1
    if (target < 0 || used.has(target)) throw failure()
    used.add(target)
    const after = incoming[target]!
    if (before.text !== after.text && (!before.text || !after.text || before.text[0] !== after.text[0] || before.text.at(-1) !== after.text.at(-1))) throw failure()
    targets.set(before, after)
  }
  return targets
}

/** Preserve native IDs in the same version-checked page write as the content change. */
export function preserveConfluenceMarkers(current: string, next: string): string {
  if (!current.includes('<ac:inline-comment-marker')) return next
  const replacements: { from: number; to: number; text: string }[] = []
  for (const [before, after] of markerTargets(blocks(current), blocks(next))) {
    const mapped = joinedMarkers(before.markers).map(marker => mapMarker(marker, before.text, after.text))
    for (const leaf of after.leaves) {
      const ranges = mapped.filter(marker => marker.from < leaf.to && marker.to > leaf.from)
      if (!ranges.length) continue
      const boundaries = [...new Set([leaf.from, leaf.to, ...ranges.flatMap(marker => [Math.max(marker.from, leaf.from), Math.min(marker.to, leaf.to)])])].sort((a, b) => a - b)
      let text = ''
      for (let part = 0; part < boundaries.length - 1; part++) {
        const from = boundaries[part]!, to = boundaries[part + 1]!
        const active = ranges.filter(marker => marker.from <= from && marker.to >= to).sort((a, b) => a.from - b.from || b.to - a.to || a.ref.localeCompare(b.ref))
        text += active.map(marker => `<${markerTag} ac:ref="${escapeXml(marker.ref)}">`).join('')
        text += escapeXml(after.text.slice(from, to))
        text += active.map(() => `</${markerTag}>`).join('')
      }
      if (leaf.node.startIndex == null || leaf.node.endIndex == null) throw failure()
      replacements.push({ from: leaf.node.startIndex, to: leaf.node.endIndex + 1, text })
    }
  }
  for (const replacement of replacements.sort((a, b) => b.from - a.from)) next = next.slice(0, replacement.from) + replacement.text + next.slice(replacement.to)
  return next
}
