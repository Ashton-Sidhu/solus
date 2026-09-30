/**
 * Ask the browser for files. Resolves an empty list when the user cancels.
 * No `accept` filter: any file can be attached, and a phone's picker then
 * offers its photo and video library as well as its files.
 */
export function pickFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.addEventListener('change', () => resolve(Array.from(input.files ?? [])), { once: true })
    input.addEventListener('cancel', () => resolve([]), { once: true })
    input.click()
  })
}
