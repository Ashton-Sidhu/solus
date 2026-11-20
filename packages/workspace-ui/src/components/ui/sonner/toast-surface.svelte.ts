/** Keep notifications inside Settings' pointer and keyboard focus boundary. */
class ToastSurface {
  target = $state<HTMLElement | null>(null)

  attach(target: HTMLElement): () => void {
    this.target = target
    return () => {
      if (this.target === target) this.target = null
    }
  }
}

export const toastSurface = new ToastSurface()
