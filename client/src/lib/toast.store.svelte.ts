export interface ToastAction {
  label: string
  onAction: () => void
}

export interface ToastOptions {
  duration?: number
  actions?: ToastAction[]
}

export interface Toast {
  id: number
  kind: 'error' | 'info'
  message: string
  actions: ToastAction[]
}

const DEFAULT_DURATION = 6000

class ToastStore {
  active: Toast | null = $state(null)

  private nextId = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  error(message: string, options?: ToastOptions): number {
    return this.show('error', message, options)
  }

  info(message: string, options?: ToastOptions): number {
    return this.show('info', message, options)
  }

  dismiss(id?: number): boolean {
    if (!this.active || (id !== undefined && this.active.id !== id)) return false
    this.clearTimer()
    this.active = null
    return true
  }

  private show(kind: Toast['kind'], message: string, options?: ToastOptions): number {
    this.clearTimer()

    const id = ++this.nextId
    const duration = options?.duration ?? DEFAULT_DURATION
    this.active = {
      id,
      kind,
      message,
      actions: options?.actions?.slice(0, 2) ?? [],
    }

    if (duration !== Infinity) {
      this.timer = setTimeout(() => this.dismiss(id), Math.max(0, duration))
    }

    return id
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

export const toasts = new ToastStore()
