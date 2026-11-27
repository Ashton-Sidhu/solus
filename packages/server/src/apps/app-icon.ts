import { createHash } from 'node:crypto'
import { SaxesParser } from 'saxes'
import { APP_ICON_FILE, MAX_APP_ICON_BYTES } from '@solus/contracts/apps'

/**
 * The icon of an app (docs/app-shortcuts.md §4): an optional `icon.svg`
 * beside `app.ts`. The host checks it at each save and each build, so a
 * client and a launcher get only a plain, self-contained SVG: no script, no
 * content of another kind, and no file or address outside the icon.
 */

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
/** Content of a page, not of an image. The elements of an editor's own namespace (Inkscape's, for example) are kept: an image does not show them. */
const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml'
/** Elements that run code or show content of another kind. `image` is refused too: an icon draws its shapes itself. */
const REFUSED_ELEMENTS = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed', 'image', 'audio', 'video', 'canvas', 'html', 'body'])
/** A `url(...)` in an attribute or a style that names anything but an element of the icon (`url(#shape)`). */
const OUTSIDE_URL = /url\(\s*(?!['"]?#)/iu

interface IconFacts {
  /** The first element: an SVG one, with a viewBox, is an icon. */
  root: { isSvg: boolean; hasViewBox: boolean } | null
  /** The first error of the XML parser. */
  malformed: string | null
  /** The first part an icon may not have. */
  problem: string | null
}

export function appIconHash(svg: string): string {
  return createHash('sha256').update(svg).digest('hex')
}

/** What is wrong with an icon, as one sentence that says how to fix it; null when the icon is good. */
export function appIconProblem(bytes: Uint8Array): string | null {
  if (bytes.byteLength > MAX_APP_ICON_BYTES) return `${APP_ICON_FILE} is ${bytes.byteLength} bytes. An icon can be at most ${MAX_APP_ICON_BYTES} bytes (64 KiB). Simplify or minify it.`
  let svg: string
  try {
    svg = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return `${APP_ICON_FILE} is not UTF-8 text. Write it as an SVG file, as a vector editor exports it.`
  }
  if (/<!(?:DOCTYPE|ENTITY)/iu.test(svg)) return `${APP_ICON_FILE} declares a DOCTYPE or an entity. Remove it.`
  // The parser's handlers write what they find here; a closure does not narrow a local.
  const found: IconFacts = { root: null, malformed: null, problem: null }
  const parser = new SaxesParser({ xmlns: true })
  parser.on('error', (error) => {
    found.malformed ??= (error.message.split('\n')[0] ?? error.message).replace(/\.$/u, '')
  })
  parser.on('processinginstruction', (instruction) => {
    found.problem ??= `${APP_ICON_FILE} has a <?${instruction.target}?> instruction. Remove it: an icon loads no stylesheet or other file.`
  })
  parser.on('opentag', (tag) => {
    if (found.root === null) found.root = { isSvg: tag.local === 'svg' && tag.uri === SVG_NAMESPACE, hasViewBox: 'viewBox' in tag.attributes }
    if (found.problem !== null) return
    if (REFUSED_ELEMENTS.has(tag.local.toLowerCase()) || tag.uri === XHTML_NAMESPACE) {
      found.problem = `${APP_ICON_FILE} has a <${tag.name}> element. Remove it: an icon has only SVG shapes, and runs no script.`
      return
    }
    for (const attribute of Object.values(tag.attributes)) {
      const name = attribute.local.toLowerCase()
      const value = attribute.value.trim()
      if (name.startsWith('on')) found.problem = `${APP_ICON_FILE} has an ${attribute.name} attribute on <${tag.name}>. Remove it: an icon runs no script.`
      else if (name === 'href' && !value.startsWith('#')) found.problem = `${APP_ICON_FILE} links <${tag.name}> to ${value}. Link only to an element of the icon, as href="#shape".`
      // An animation can change a link to an address outside the icon.
      else if (name === 'attributename' && value.toLowerCase().endsWith('href')) found.problem = `${APP_ICON_FILE} animates a link on <${tag.name}>. Remove the animation.`
      else if (OUTSIDE_URL.test(value)) found.problem = `${APP_ICON_FILE} names a file in ${attribute.name} on <${tag.name}>. Use only url(#id) of an element of the icon.`
      if (found.problem !== null) return
    }
  })
  const checkStyleText = (text: string) => {
    if (found.problem === null && (OUTSIDE_URL.test(text) || /@import/iu.test(text))) found.problem = `${APP_ICON_FILE} names a file in a style. Use only url(#id) of an element of the icon.`
  }
  parser.on('text', checkStyleText)
  parser.on('cdata', checkStyleText)
  try {
    parser.write(svg).close()
  } catch {
    // The error handler kept the first error.
  }
  const { root, malformed, problem } = found
  if (malformed !== null || root === null) return `${APP_ICON_FILE} is not well-formed XML: ${malformed ?? 'it has no root element'}. Write it as an SVG file, as a vector editor exports it.`
  if (!root.isSvg) return `${APP_ICON_FILE} must have one <svg xmlns="${SVG_NAMESPACE}"> root element.`
  if (!root.hasViewBox) return `${APP_ICON_FILE} has no viewBox on its <svg> element. Add one, as viewBox="0 0 64 64", so the icon scales to each size.`
  return problem
}
