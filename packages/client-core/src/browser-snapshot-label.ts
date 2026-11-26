/**
 * The short name of a browser capture on its card, on desktop, web, and mobile.
 *
 * A page with no `<title>` gets its address as a title from Chromium, without
 * the scheme: `[::1]:5173/@fs/Users/…`. That name cut to a card's width says
 * nothing, so the card names the last part of the path (`mockup.html`) instead.
 */
export function browserSnapshotLabel(snapshot: { title: string; url: string }): string {
  const title = snapshot.title.trim()
  if (title && !isAddressTitle(title, snapshot.url)) return title
  return lastPathSegment(snapshot.url) || 'Browser screenshot'
}

function isAddressTitle(title: string, url: string): boolean {
  const bare = (address: string) => decoded(address.replace(/^[a-z][a-z\d+.-]*:\/\//i, '').replace(/\/+$/, ''))
  return bare(title) === bare(url)
}

function lastPathSegment(url: string): string {
  let path: string
  try {
    path = new URL(url).pathname
  } catch {
    return ''
  }
  return decoded(path.split('/').filter(Boolean).at(-1) ?? '')
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}
