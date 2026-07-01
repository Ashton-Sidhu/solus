// Curated inline-SVG icon set, stroke=currentColor, 16×16 viewBox.
// Shared between DiagramNode (rendering) and IconPicker (selection UI).
export const ICON_SVG: Record<string, string> = {
  service: '<rect x="2" y="4" width="12" height="8" rx="1.5"/><path d="M2 7.5h12"/><circle cx="4.5" cy="5.75" r=".65" fill="currentColor"/><circle cx="6.5" cy="5.75" r=".65" fill="currentColor"/>',
  db: '<ellipse cx="8" cy="4.5" rx="5" ry="2"/><path d="M3 4.5v7c0 1.1 2.24 2 5 2s5-.9 5-2v-7"/><path d="M3 8c0 1.1 2.24 2 5 2s5-.9 5-2"/>',
  queue: '<rect x="2" y="4" width="12" height="7" rx="1"/><path d="M2 8.5h12M5 11v2.5M11 11v2.5M5 4V1.5M11 4V1.5"/>',
  external: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c-2 2-3 3.7-3 5.5s1 3.5 3 5.5M8 2.5c2 2 3 3.7 3 5.5s-1 3.5-3 5.5"/>',
  client: '<rect x="2" y="3" width="12" height="8.5" rx="1.5"/><path d="M5.5 13.5h5M8 11.5v2"/>',
  group: '<path d="M1.5 6h13v7a1 1 0 01-1 1h-11a1 1 0 01-1-1V6z"/><path d="M1.5 6V5a1 1 0 011-1h3.5L7.5 6"/>',
  api: '<path d="M6 4.5L3 8l3 3.5M10 4.5l3 3.5-3 3.5M9.5 4l-3 8"/>',
  cache: '<rect x="2" y="2" width="12" height="12" rx="1.5"/><path d="M2 7h12M2 10h12M7 2v12M10 2v12"/>',
  auth: '<path d="M5.5 7.5V6a2.5 2.5 0 015 0v1.5"/><rect x="4" y="7.5" width="8" height="6.5" rx="1.5"/><circle cx="8" cy="10.5" r="1.2" fill="currentColor"/>',
  gateway: '<path d="M2 5.5l5 2.5-5 2.5M14 8H7M10 4.5l4 3.5-4 3.5"/>',
  storage: '<rect x="2" y="2.5" width="12" height="4" rx="1"/><rect x="2" y="8.5" width="12" height="4" rx="1"/><path d="M6 4.5h4M6 10.5h4"/>',
  function: '<path d="M5 3.5h1.5a1 1 0 011 1v3a1.5 1.5 0 001.5 1.5 1.5 1.5 0 00-1.5 1.5v3a1 1 0 01-1 1H5M11 3.5h-1.5a1 1 0 00-1 1v3A1.5 1.5 0 007 9a1.5 1.5 0 001.5 1.5v3a1 1 0 001 1H11"/>',
  broker: '<circle cx="8" cy="8" r="2.5"/><path d="M8 2v3.5M8 10.5V14M2 8h3.5M10.5 8H14M3.5 3.5L6 6M10 10l2.5 2.5M12.5 3.5L10 6M6 10l-2.5 2.5"/>',
  load_balancer: '<path d="M8 3.5v3M4 12.5v-3M12 12.5v-3M8 6.5l-4 3M8 6.5l4 3"/><circle cx="8" cy="3.5" r="1.5" fill="currentColor"/><circle cx="4" cy="12.5" r="1.5" fill="currentColor"/><circle cx="12" cy="12.5" r="1.5" fill="currentColor"/>',
  cdn: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c-2 2-3 3.7-3 5.5s1 3.5 3 5.5M8 2.5c2 2 3 3.7 3 5.5s-1 3.5-3 5.5"/><circle cx="12" cy="4.5" r="1.5" fill="currentColor" stroke="none"/>',
  // Default glyph for data-model entities (a node carrying `fields`).
  table: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M2 6h12M6 6v7.5"/>',
}

/** Matches Iconify `prefix:name` format (e.g. `logos:postgresql`). */
export const isIconifyName = (icon: string): boolean => /^[a-z0-9-]+:[a-z0-9-]+$/.test(icon)

/**
 * Resolve an icon string to exactly one of three render strategies:
 * an Iconify `prefix:name`, a curated inline SVG, or an emoji fallback.
 * Shared by DiagramNode and DiagramGroupNode so the rules stay in one place.
 * `fallbackKey` is the curated glyph used when the icon is unset/unknown.
 */
export function resolveIcon(
  icon: string | undefined,
  fallbackKey = 'service',
): { iconify: string | null; svg: string | null; emoji: string | null } {
  const iconify = icon && isIconifyName(icon) ? icon : null
  if (iconify) return { iconify, svg: null, emoji: null }
  const key = icon && ICON_SVG[icon] ? icon : fallbackKey
  const svg = ICON_SVG[key] ?? null
  if (svg) return { iconify: null, svg, emoji: null }
  return { iconify: null, svg: null, emoji: icon ?? '⬡' }
}

/** Curated icon list shown in the picker: generic glyphs first, then brand logos. */
export const CURATED_ICONS: { icon: string; label: string }[] = [
  // Generic abstract glyphs
  { icon: 'service', label: 'Service' },
  { icon: 'db', label: 'Database' },
  { icon: 'table', label: 'Table / Entity' },
  { icon: 'queue', label: 'Queue' },
  { icon: 'cache', label: 'Cache' },
  { icon: 'gateway', label: 'Gateway' },
  { icon: 'auth', label: 'Auth' },
  { icon: 'storage', label: 'Storage' },
  { icon: 'function', label: 'Function' },
  { icon: 'load_balancer', label: 'Load Balancer' },
  { icon: 'api', label: 'API' },
  { icon: 'broker', label: 'Broker' },
  { icon: 'client', label: 'Client' },
  { icon: 'external', label: 'External' },
  { icon: 'cdn', label: 'CDN' },
  // Brand logos
  { icon: 'logos:postgresql', label: 'PostgreSQL' },
  { icon: 'logos:redis', label: 'Redis' },
  { icon: 'logos:mongodb', label: 'MongoDB' },
  { icon: 'logos:mysql', label: 'MySQL' },
  { icon: 'logos:kafka', label: 'Kafka' },
  { icon: 'logos:rabbitmq', label: 'RabbitMQ' },
  { icon: 'logos:nginx', label: 'Nginx' },
  { icon: 'logos:docker', label: 'Docker' },
  { icon: 'logos:kubernetes', label: 'Kubernetes' },
  { icon: 'logos:aws', label: 'AWS' },
  { icon: 'logos:graphql', label: 'GraphQL' },
  { icon: 'logos:nodejs', label: 'Node.js' },
  { icon: 'logos:react', label: 'React' },
  { icon: 'logos:python', label: 'Python' },
  { icon: 'logos:elasticsearch', label: 'Elasticsearch' },
  { icon: 'logos:stripe', label: 'Stripe' },
]
