import { useEffect, useState } from 'react'

/**
 * The open page, from the address after `#`: `#/` or `#/notes/<id>`. The app
 * runs in a frame with no address of its own, so pages live in the fragment.
 * Link with `<a href="#/notes/42">` and move from code with `location.hash`.
 */
export function useRoute(): string[] {
  const read = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
  const [parts, setParts] = useState(read)
  useEffect(() => {
    const update = () => setParts(read())
    addEventListener('hashchange', update)
    return () => removeEventListener('hashchange', update)
  }, [])
  return parts
}
