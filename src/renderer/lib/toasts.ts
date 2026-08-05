import { toast, type ExternalToast } from "svelte-sonner"

export type ToastId = string | number

/** Visual tone of a toast. */
export type ToastVariant = "info" | "success" | "error" | "undo"

/** Optional action button shown on the trailing edge of a toast. */
export interface ToastAction {
  /** Button label, e.g. "Undo". */
  label: string
  /** Invoked when the user activates the action. Terminal: it dismisses the
   *  toast WITHOUT firing onDismiss (the action supersedes the auto-commit). */
  onAction: () => void
}

/** A single transient toast. */
export interface ToastSpec {
  /** The line shown to the user, e.g. "Comment deleted" or "Saved". */
  message: string
  /** Visual tone. Defaults to "info". */
  variant?: ToastVariant
  /** How long the toast stays before auto-dismissing, in ms. */
  duration?: number
  /** Optional trailing action (e.g. Undo). */
  action?: ToastAction
  /** Up to two actions mapped to Sonner's action and cancel buttons. When
   *  present, {@link action} is ignored. */
  actions?: ToastAction[]
  /** Called when the toast auto-dismisses, is replaced, or is manually dismissed.
   *  NOT called when the user activates {@link action}. */
  onDismiss?: () => void
}

interface ActiveToast {
  id?: ToastId
  action?: ToastAction
  onDismiss?: () => void
  settled: boolean
}

type ToastOptions = Omit<ToastSpec, "message" | "variant">

async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }

    const textarea = document.createElement("textarea")
    textarea.value = text
    textarea.style.position = "fixed"
    textarea.style.opacity = "0"
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand("copy")
    textarea.remove()
  } catch {
    // Clipboard access can be denied by the browser or OS.
  }
}

/** App-wide Sonner adapter preserving Solus replacement and deferred-commit semantics. */
class ToastService {
  #active: ActiveToast | null = null

  /** Show a toast, committing (dismissing) any toast it replaces. */
  show(spec: ToastSpec): ToastId {
    this.#commitActive()

    const actions = spec.actions?.length ? spec.actions : spec.action ? [spec.action] : []
    const active: ActiveToast = {
      // Only a lone action drives Cmd+Z undo; multi-action toasts don't.
      action: spec.actions?.length ? undefined : spec.action,
      onDismiss: spec.onDismiss,
      settled: false,
    }
    this.#active = active

    const toastOptions: ExternalToast = {
      duration: spec.duration,
      onDismiss: () => this.#settle(active, true),
      onAutoClose: () => this.#settle(active, true),
      action: actions[0]
        ? {
            label: actions[0].label,
            onClick: () => this.#runAction(active, actions[0]),
          }
        : undefined,
      cancel: actions[1]
        ? {
            label: actions[1].label,
            onClick: () => this.#runAction(active, actions[1]),
          }
        : undefined,
    }

    const id = (() => {
      switch (spec.variant) {
        case "success":
          return toast.success(spec.message, toastOptions)
        case "error":
          return toast.error(spec.message, toastOptions)
        case "info":
          return toast.info(spec.message, toastOptions)
        default:
          return toast(spec.message, toastOptions)
      }
    })()
    active.id = id
    return id
  }

  success(message: string, opts?: ToastOptions): ToastId {
    return this.show({ ...opts, message, variant: "success" })
  }

  error(message: string, opts?: ToastOptions): ToastId {
    const copyAction: ToastAction = {
      label: "Copy",
      onAction: () => void copyText(message),
    }

    if (opts?.actions?.length) {
      return this.show({ ...opts, message, variant: "error", actions: [...opts.actions, copyAction] })
    }

    if (opts?.action) {
      return this.show({ ...opts, message, variant: "error", action: undefined, actions: [opts.action, copyAction] })
    }

    return this.show({ ...opts, message, variant: "error", action: copyAction })
  }

  info(message: string, opts?: ToastOptions): ToastId {
    return this.show({ ...opts, message, variant: "info" })
  }

  /** Show an Undo toast. The commit runs only if the undo window lapses. */
  undo(
    message: string,
    onUndo: () => void,
    opts?: { actionLabel?: string; duration?: number; onDismiss?: () => void },
  ): ToastId {
    return this.show({
      message,
      variant: "undo",
      duration: opts?.duration,
      onDismiss: opts?.onDismiss,
      action: { label: opts?.actionLabel ?? "Undo", onAction: onUndo },
    })
  }

  /** Dismiss the active Solus toast, optionally only when its ID matches. */
  dismiss(id?: ToastId): boolean {
    const active = this.#active
    if (!active || (id !== undefined && active.id !== id)) return false
    this.#settle(active, true)
    if (active.id !== undefined) toast.dismiss(active.id)
    return true
  }

  isActive(id: ToastId): boolean {
    return this.#active?.id === id
  }

  /** Cmd/Ctrl+Z activates an Undo toast unless focus is in an editable field. */
  handleKeydown = (event: KeyboardEvent): void => {
    const active = this.#active
    if (!active?.action || active.action.label !== "Undo") return
    if (event.shiftKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return
    const target = event.target as HTMLElement | null
    if (target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))) return

    event.preventDefault()
    if (active.id !== undefined) toast.dismiss(active.id)
    this.#runAction(active)
  }

  #runAction(active: ActiveToast, action = active.action): void {
    this.#settle(active, false)
    action?.onAction()
  }

  #commitActive(): void {
    const active = this.#active
    if (!active) return
    this.#settle(active, true)
    if (active.id !== undefined) toast.dismiss(active.id)
  }

  #settle(active: ActiveToast, commit: boolean): void {
    if (active.settled) return
    active.settled = true
    if (this.#active === active) this.#active = null
    if (commit) active.onDismiss?.()
  }
}

export const toasts = new ToastService()
