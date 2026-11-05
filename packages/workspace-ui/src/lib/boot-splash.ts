/**
 * The Solus loading screen (the boot splash): the Solus mark, centred on the edge
 * background. `scripts/vite-boot-splash.ts` writes it into the HTML of the
 * desktop renderer and of the web client, so it paints before any code or
 * stylesheet loads. Each client removes it when its first surface mounts.
 *
 * The styles are literals, because the app's stylesheet has not loaded: the
 * backgrounds are `--solus-edge-bg` in dark and light mode. The theme script in
 * each index.html sets `html.light` before the first paint.
 *
 * The mark breathes for a few cycles and then stays still. It does not move when
 * the person asks for reduced motion.
 */

export const BOOT_SPLASH_ID = 'solus-boot-shell'

/**
 * The size of the mark. The desktop boot scene (`apps/desktop/src/renderer/boot-scene.ts`)
 * draws the same mark at this size and centre on a boot failure, so the splash
 * gets detail and does not paint again.
 */
export const BOOT_SPLASH_MARK_SIZE = '5.25rem'

export const BOOT_SPLASH_MARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" aria-hidden="true">'
  + '<circle cx="512" cy="512" r="180" fill="#B45A3C" />'
  + '<g fill="none" stroke="#D97757" stroke-width="60" stroke-linecap="round">'
  + '<path d="M512,212 A300,300 0 0 1 812,512" />'
  + '<path d="M764,716 A300,300 0 0 1 416,800" />'
  + '<path d="M260,716 A300,300 0 0 1 212,416" />'
  + '</g></svg>'

// The keyframes give only the dim start: each cycle ends at the mark's own
// style, so the mark stops there with no jump when the cycles end.
export const BOOT_SPLASH_STYLE = `#${BOOT_SPLASH_ID}{position:fixed;inset:0;display:grid;place-items:center;background:#21201d;z-index:2147483647}`
  + `html.light #${BOOT_SPLASH_ID}{background:#fbfaf6}`
  + `#${BOOT_SPLASH_ID} svg{width:${BOOT_SPLASH_MARK_SIZE};height:${BOOT_SPLASH_MARK_SIZE};opacity:.95}`
  + `@media (prefers-reduced-motion:no-preference){#${BOOT_SPLASH_ID} svg{animation:solus-boot-breathe .9s ease-in-out 5 alternate}}`
  + '@keyframes solus-boot-breathe{from{opacity:.4;transform:scale(.97)}}'

export const BOOT_SPLASH_MARKUP = `<div id="${BOOT_SPLASH_ID}">${BOOT_SPLASH_MARK}</div>`
