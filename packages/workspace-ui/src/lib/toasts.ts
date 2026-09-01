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
  /** Short title shown to the user, e.g. "Comment deleted" or "Saved". */
  message: string
  /** Supporting detail shown below the title. */
  description?: string
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
  /** Show Sonner's close (×) affordance in the corner of the toast. */
  closeButton?: boolean
  /** Reuse an existing toast slot so this toast replaces it in place. */
  id?: ToastId
  /** Class on the toast element. Absent clears the class of a reused slot. */
  class?: string
}

/** Live handle on a running operation's toast. */
export interface ProgressToast {
  /** Replace the running title, e.g. when the operation reaches a new phase. */
  update(message: string): void
  /** Replace the running toast with a success toast. */
  success(message: string, opts?: ToastOptions): void
  /** Replace the running toast with an error toast. */
  error(message: string, opts?: ToastOptions): void
  /** Replace the running toast with a neutral toast. */
  info(message: string, opts?: ToastOptions): void
  /** Remove the running toast without a terminal message. */
  dismiss(): void
}

interface ActiveToast {
  id?: ToastId
  onDismiss?: () => void
  settled: boolean
}

type ToastOptions = Omit<ToastSpec, "message" | "variant">

/** Write text to the clipboard, falling back to a detached textarea where the
 *  async API is unavailable or denied. Exported because every surface that
 *  offers a "copy this" affordance needs the same fallback. */
export async function copyText(text: string): Promise<void> {
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

/** App-wide Sonner adapter preserving Solus deferred-commit semantics. */
class ToastService {
  /** Every toast on screen, keyed by its Sonner ID. Sonner stacks them, and each
   *  carries its own deferred commit, so a new toast never settles a live one. */
  #active = new Map<ToastId, ActiveToast>()

  /** Show a toast. Reusing an ID replaces that toast in place and commits it. */
  show(spec: ToastSpec): ToastId {
    if (spec.id !== undefined) this.#settle(this.#active.get(spec.id), true)

    const actions = spec.actions?.length ? spec.actions : spec.action ? [spec.action] : []
    const active: ActiveToast = { onDismiss: spec.onDismiss, settled: false }

    const toastOptions: ExternalToast = {
      id: spec.id,
      class: spec.class,
      closeButton: spec.closeButton,
      description: spec.description,
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
    this.#active.set(id, active)
    return id
  }

  success(message: string, opts?: ToastOptions): ToastId {
    return this.show({ ...opts, message, variant: "success" })
  }

  error(message: string, opts?: ToastOptions): ToastId {
    const copy = opts?.description ? `${message}\n${opts.description}` : message
    const copyAction: ToastAction = {
      label: "Copy",
      onAction: () => void copyText(copy),
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

  /** Show a spinner toast that stays until the caller settles it. */
  progress(message: string): ProgressToast {
    const active: ActiveToast = { settled: false }

    // Sonner hides its close button on "loading" toasts, so this is a plain
    // toast that the Toaster draws a spinner on.
    const render = (title: string) => {
      if (active.settled) return
      active.id = toast(title, {
        id: active.id,
        class: "solus-toast-progress",
        duration: Number.POSITIVE_INFINITY,
        closeButton: true,
        onDismiss: () => this.#settle(active, true),
      })
      this.#active.set(active.id, active)
    }
    render(message)

    // Hand the toast slot to the terminal toast so it morphs in place instead
    // of the user seeing the spinner vanish and a second toast fly in.
    const settleWith = (variant: ToastVariant, terminalMessage: string, opts?: ToastOptions) => {
      const slotId = active.settled ? undefined : active.id
      this.#settle(active, false)
      this.show({ ...opts, message: terminalMessage, variant, closeButton: true, id: slotId })
    }

    return {
      update: (next: string) => render(next),
      success: (terminalMessage, opts) => settleWith("success", terminalMessage, opts),
      error: (terminalMessage, opts) => {
        const slotId = active.settled ? undefined : active.id
        this.#settle(active, false)
        this.error(terminalMessage, { ...opts, closeButton: true, id: slotId })
      },
      info: (terminalMessage, opts) => settleWith("info", terminalMessage, opts),
      dismiss: () => {
        const slotId = active.settled ? undefined : active.id
        this.#settle(active, false)
        if (slotId !== undefined) toast.dismiss(slotId)
      },
    }
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

  /** Dismiss one toast by ID, or every toast on screen when no ID is given. */
  dismiss(id?: ToastId): boolean {
    if (id === undefined) {
      if (this.#active.size === 0) return false
      for (const active of [...this.#active.values()]) this.#dismissActive(active)
      return true
    }

    const active = this.#active.get(id)
    if (!active) return false
    this.#dismissActive(active)
    return true
  }

  isActive(id: ToastId): boolean {
    return this.#active.has(id)
  }

  #dismissActive(active: ActiveToast): void {
    const id = active.id
    this.#settle(active, true)
    if (id !== undefined) toast.dismiss(id)
  }

  #runAction(active: ActiveToast, action: ToastAction): void {
    this.#settle(active, false)
    action.onAction()
  }

  #settle(active: ActiveToast | undefined, commit: boolean): void {
    if (!active || active.settled) return
    active.settled = true
    if (active.id !== undefined && this.#active.get(active.id) === active) this.#active.delete(active.id)
    if (commit) active.onDismiss?.()
  }
}

export const toasts = new ToastService()
