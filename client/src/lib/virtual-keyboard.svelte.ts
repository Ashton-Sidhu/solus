class VirtualKeyboardState {
  keyboardHeight = $state(0)
  isKeyboardVisible = $state(false)
  viewportHeight = $state(typeof window !== 'undefined' ? (window.visualViewport?.height ?? window.innerHeight) : 0)

  private cleanup: (() => void) | null = null

  constructor() {
    if (typeof window === 'undefined') return
    if (!window.visualViewport) return

    const vv = window.visualViewport
    let rafId = 0

    const commit = () => {
      rafId = 0
      const fullHeight = window.innerHeight
      const vvHeight = vv.height
      const offset = fullHeight - vvHeight
      const threshold = 100
      const height = offset > threshold ? offset : 0
      if (height !== this.keyboardHeight) {
        this.keyboardHeight = height
        this.isKeyboardVisible = height > 0
      }
      if (vvHeight !== this.viewportHeight) {
        this.viewportHeight = vvHeight
      }
    }

    const schedule = () => {
      if (!rafId) rafId = requestAnimationFrame(commit)
    }

    vv.addEventListener('resize', schedule)
    vv.addEventListener('scroll', schedule)
    this.cleanup = () => {
      vv.removeEventListener('resize', schedule)
      vv.removeEventListener('scroll', schedule)
      if (rafId) cancelAnimationFrame(rafId)
    }
  }

  destroy() {
    this.cleanup?.()
  }
}

export const virtualKeyboard = new VirtualKeyboardState()
