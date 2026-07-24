// Layout: which shell to render (mobile vs desktop)
export const MOBILE_QUERY = '(max-width: 767px)'
// Layout: collapse secondary panels (sidebar, TOC rail)
const COMPACT_QUERY = '(max-width: 1100px)'
// Input: primary pointer is imprecise (phone, tablet)
const TOUCH_QUERY = '(pointer: coarse)'
// Input: any connected pointer is precise (iPad + Magic Keyboard, touch laptop with trackpad)
const FINE_POINTER_QUERY = '(any-pointer: fine)'

class RuntimeStore {
  isMobileViewport = $state(typeof window !== 'undefined' ? window.matchMedia(MOBILE_QUERY).matches : false)
  isCompactViewport = $state(typeof window !== 'undefined' ? window.matchMedia(COMPACT_QUERY).matches : false)
  isTouchDevice = $state(typeof window !== 'undefined' ? window.matchMedia(TOUCH_QUERY).matches : false)
  hasKeyboardPointer = $state(typeof window !== 'undefined' ? window.matchMedia(FINE_POINTER_QUERY).matches : true)

  // Focus suppression: true on phones/tablets without keyboard, false for desktop and iPad+keyboard
  get shouldSuppressFocus(): boolean {
    return this.isTouchDevice && !this.hasKeyboardPointer
  }

  constructor() {
    if (typeof window === 'undefined') return

    const listen = (query: string, setter: (v: boolean) => void) => {
      const mq = window.matchMedia(query)
      mq.addEventListener('change', (e) => setter(e.matches))
    }

    listen(MOBILE_QUERY, (v) => this.isMobileViewport = v)
    listen(COMPACT_QUERY, (v) => this.isCompactViewport = v)
    listen(TOUCH_QUERY, (v) => this.isTouchDevice = v)
    listen(FINE_POINTER_QUERY, (v) => this.hasKeyboardPointer = v)
  }
}

export const runtime = new RuntimeStore()
