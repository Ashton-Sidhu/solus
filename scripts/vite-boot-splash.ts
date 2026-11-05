import type { Plugin } from 'vite'
import { BOOT_SPLASH_MARKUP, BOOT_SPLASH_STYLE } from '../packages/workspace-ui/src/lib/boot-splash'
import { DEFERRED_STYLESHEET_ATTRIBUTE } from '../apps/client/src/lib/page-styles'

const ROOT_ELEMENT = '<div id="root"></div>'

/**
 * Writes the Solus loading screen (`packages/workspace-ui/src/lib/boot-splash.ts`)
 * into the page's HTML, in the dev server and in the build: its styles into the
 * head and its markup into the empty root. The desktop renderer and the web
 * client use the same plugin, so they show the same splash.
 */
export function bootSplash(): Plugin {
  return {
    name: 'solus-boot-splash',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        if (!html.includes(ROOT_ELEMENT)) throw new Error(`index.html has no empty ${ROOT_ELEMENT} for the boot splash`)
        return html
          .replace('</head>', `<style>${BOOT_SPLASH_STYLE}</style></head>`)
          .replace(ROOT_ELEMENT, `<div id="root">${BOOT_SPLASH_MARKUP}</div>`)
      },
    },
  }
}

const STYLESHEET_LINK = /<link rel="stylesheet"([^>]*)>/g

/**
 * Web only. Vite links the entry's stylesheet (545 KB) with `rel="stylesheet"`,
 * and the browser paints nothing until it arrives; WebKit waits for it even when
 * the page shows only the splash (docs/plans/fast-secure-startup.md, step 5).
 * This links it as a preload that becomes the stylesheet when it arrives, so the
 * splash paints with the HTML. The page mounts no surface before the stylesheet
 * applies (`apps/client/src/lib/page-styles.ts`). A page with no script gets the
 * plain stylesheet from `<noscript>`.
 *
 * The desktop renderer keeps the plain link: it loads from disk, and its window
 * shows only after the app mounts.
 */
export function nonBlockingStylesheets(): Plugin {
  return {
    name: 'solus-non-blocking-stylesheets',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        if (!html.includes('<link rel="stylesheet"')) throw new Error('index.html links no stylesheet to load without blocking')
        return html.replace(STYLESHEET_LINK, (_link, attributes: string) =>
          `<link rel="preload" as="style"${attributes} ${DEFERRED_STYLESHEET_ATTRIBUTE} onload="this.onload=null;this.rel='stylesheet'">`
          + `<noscript><link rel="stylesheet"${attributes}></noscript>`)
      },
    },
  }
}

const ENTRY_SCRIPT = /<script type="module" crossorigin src="([^"]+)"><\/script>/g

/**
 * Web only. A module script holds `DOMContentLoaded` until it has loaded and run, and
 * Safari holds the first paint of a page reached from another site until then too: a
 * fresh login painted the splash only when the 460 KB entry had run, about 300 ms after
 * the HTML arrived (docs/benchmarks/fresh-login-profile-2026-11-01.json).
 *
 * The entry moves to the end of the body and becomes `async`: the parse ends, and the
 * splash paints, while the entry still loads. When the parser reaches it, `#root`, the
 * shell's data blocks, and the stylesheet links are in the document, so the entry reads
 * the page as before. A `modulepreload` keeps its download starting from the head.
 *
 * The desktop renderer keeps the plain script: its window shows only after the app mounts.
 */
export function asyncEntryScript(): Plugin {
  return {
    name: 'solus-async-entry-script',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const entries = [...html.matchAll(ENTRY_SCRIPT)]
        if (entries.length !== 1) throw new Error(`index.html must have one module entry script, not ${entries.length}`)
        if (!html.includes('</body>')) throw new Error('index.html has no </body> for the entry script')
        const src = entries[0]![1]!
        return html
          .replace(ENTRY_SCRIPT, `<link rel="modulepreload" crossorigin href="${src}">`)
          .replace('</body>', `<script type="module" async crossorigin src="${src}"></script></body>`)
      },
    },
  }
}
