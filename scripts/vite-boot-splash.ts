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
