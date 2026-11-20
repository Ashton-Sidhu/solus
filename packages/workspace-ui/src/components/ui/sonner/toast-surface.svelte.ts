/** Use Settings' viewport-sized focus boundary without changing toast offsets. */
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
