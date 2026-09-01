import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { IconifyIcon, IconifyJSON } from '@iconify/types'
import type { Plugin } from 'vite'
import { CURATED_ICONIFY_NAMES } from '../src/renderer/components/diagram/diagram-icons'
import { FILE_TYPE_ICON_NAMES } from '../src/renderer/lib/fileTypeIcon'

const require = createRequire(import.meta.url)
const VIRTUAL_ID = 'virtual:solus-icons'
const RESOLVED_ID = `\0${VIRTUAL_ID}`

const LOCAL_ICON_NAMES = Array.from(new Set([
  ...FILE_TYPE_ICON_NAMES,
  ...CURATED_ICONIFY_NAMES,
  // Kept for existing diagram documents and the public schema example.
  'simple-icons:redis',
]))

interface LocalIcon {
  name: string
  data: IconifyIcon
}

function readCollection(prefix: string): IconifyJSON {
  const path = require.resolve(`@iconify-json/${prefix}/icons.json`)
  return JSON.parse(readFileSync(path, 'utf8')) as IconifyJSON
}

export function buildLocalIconSubset(): LocalIcon[] {
  const collections = new Map<string, IconifyJSON>()
  return LOCAL_ICON_NAMES.map((name) => {
    const [prefix, iconName] = name.split(':')
    let collection = collections.get(prefix)
    if (!collection) {
      collection = readCollection(prefix)
      collections.set(prefix, collection)
    }
    const icon = collection.icons[iconName]
    if (!icon) throw new Error(`Curated Iconify icon is missing: ${name}`)
    return {
      name,
      data: {
        ...icon,
        width: icon.width ?? collection.width,
        height: icon.height ?? collection.height,
      },
    }
  })
}

/** Build-time extraction keeps 12 MB of collection JSON out of both clients. */
export function solusIconSubset(): Plugin {
  return {
    name: 'solus-icon-subset',
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null
    },
    load(id) {
      if (id !== RESOLVED_ID) return null
      return `export default ${JSON.stringify(buildLocalIconSubset())}`
    },
  }
}
