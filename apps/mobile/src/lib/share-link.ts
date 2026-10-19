import type { ShareContent, ShareOptions } from 'react-native'

/** The system share sheet: React Native's `Share`, which answers `sharedAction` or `dismissedAction`. */
export interface ShareSheet {
  share(content: ShareContent, options?: ShareOptions): Promise<{ readonly action: string }>
}

/** A link to share and the title receiving apps may show with it. */
export interface SharedLink {
  readonly url: string
  readonly title: string
}

/**
 * How a share ended. Cancelling is not a failure. iOS reports a cancelled
 * sheet as `dismissed`; Android's chooser cannot report it, so Android reads
 * as `shared` once the chooser opened.
 */
export type ShareLinkResult =
  | { readonly kind: 'shared' }
  | { readonly kind: 'dismissed' }
  | { readonly kind: 'failed'; readonly message: string }

/**
 * The payload each platform's share contract expects. iOS shares the URL
 * itself, so receiving apps get a link they can preview and open. Android's
 * share intent carries text: the URL is the message, and the title is the
 * subject an email app uses.
 */
export function linkShareContent(link: SharedLink, os: string): ShareContent {
  return os === 'ios' ? { url: link.url } : { message: link.url, title: link.title }
}

/**
 * Opens the system share sheet for a link. On an iPad the sheet is a popover
 * over the window, since a native header menu item is not a view it can
 * point at.
 */
export async function shareLink(sheet: ShareSheet, link: SharedLink, os: string): Promise<ShareLinkResult> {
  try {
    const result = await sheet.share(linkShareContent(link, os), os === 'android' ? { dialogTitle: link.title } : undefined)
    return { kind: result.action === 'dismissedAction' ? 'dismissed' : 'shared' }
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}
