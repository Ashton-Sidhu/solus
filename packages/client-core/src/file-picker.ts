/**
 * Ask the browser for files. Resolves an empty list when the user cancels.
 * No `accept` filter: any file can be attached, and a phone's picker then
 * offers its photo and video library as well as its files.
 *
 * Call it synchronously inside the click or tap that asked for files. iOS
 * Safari opens the picker only while that gesture is current, so an `await`
 * before this call leaves the tap doing nothing. The input sits in the
 * document while the picker is open: WebKit can drop the `change` of a
 * detached input, which loses the files the user chose.
 */
export function pickFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.hidden = true
    const finish = (files: File[]) => {
      input.remove()
      resolve(files)
    }
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])), { once: true })
    input.addEventListener('cancel', () => finish([]), { once: true })
    document.body.append(input)
    input.click()
  })
}
