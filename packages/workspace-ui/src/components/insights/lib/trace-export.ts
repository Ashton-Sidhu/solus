// Getting a trace out of Solus: a file the browser saves.

/** Saves text as a file through the browser's own download path. Works in
 *  the web client and in the desktop renderer alike; neither needs a host
 *  round trip for a file the renderer already holds. */
export function downloadText(fileName: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Revoked after the click has been handed to the browser, not before.
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}
