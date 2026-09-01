import { getContext, setContext } from 'svelte'

const KEY = Symbol('popover-layer')

/** Pass a reactive ref (e.g. `{ get el() { return overlayEl } }`) so descendants can portal into it after mount. */
export function setPopoverLayer(ref: { el: HTMLElement | null }): void {
  setContext(KEY, ref)
}

export function getPopoverLayer(): { el: HTMLElement | null } {
  return getContext(KEY)
}

/** Document-level mousedown listener that fires `onOutside` when the click target is outside every ref. */
export function useClickOutside(
  isOpen: () => boolean,
  refs: () => Array<HTMLElement | null>,
  onOutside: () => void,
): void {
  $effect(() => {
    if (!isOpen()) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      for (const el of refs()) {
        if (el?.contains(target)) return
      }
      onOutside()
    }
    const timer = window.setTimeout(() => {
      document.addEventListener('mousedown', handler)
    }, 0)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('mousedown', handler)
    }
  })
}
