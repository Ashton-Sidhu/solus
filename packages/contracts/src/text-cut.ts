/** The first `maxLength` UTF-16 units of `text`, one fewer when the cut would
 *  end on half of a surrogate pair. A lone surrogate is not valid Unicode, and
 *  a provider that reads strict JSON rejects the whole message that holds it. */
export function cutText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  const lastKept = text.charCodeAt(maxLength - 1)
  return text.slice(0, lastKept >= 0xd800 && lastKept <= 0xdbff ? maxLength - 1 : maxLength)
}
