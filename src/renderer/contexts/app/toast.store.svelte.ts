import { toast, type ExternalToast } from "svelte-sonner"
import MultiActionToast from "../../components/ui/sonner/MultiActionToast.svelte"

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
  /** Multi-button toast rendered via a custom component. When present,
   *  {@link action} is ignored. */
  actions?: ToastAction[]
  /** Called when the toast auto-dismisses, is replaced, or is manually dismissed.
   *  NOT called when the user activates {@link action}. */
  onDismiss?: () => void
}

interface ActiveToast {
  id: number
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

/** App-wide Sonner adapter. It preserves the existing single-toast and deferred
 *  commit semantics while allowing non-component code to raise toasts. */
class ToastStore {
  #active: ActiveToast | null = null
  #seq = 0

  /** Show a toast, committing (dismissing) any toast it replaces. */
  show(spec: ToastSpec): void {
    this.#commitActive()

    const active: ActiveToast = {
      id: ++this.#seq,
      action: spec.actions?.length ? undefined : spec.action,
      onDismiss: spec.onDismiss,
      settled: false,
    }
    this.#active = active

    if (spec.actions?.length) {
      toast.custom(MultiActionToast, {
        id: active.id,
        duration: spec.duration ?? 6000,
        onDismiss: () => this.#settle(active, true),
        onAutoClose: () => this.#settle(active, true),
        componentProps: {
          message: spec.message,
          variant: spec.variant ?? "info",
          actions: spec.actions.map((action) => ({
            label: action.label,
            onClick: () => this.#runAction(active, action),
          })),
        },
      })
      return
    }

    const options: ExternalToast = {
      id: active.id,
      duration: spec.duration ?? 6000,
      onDismiss: () => this.#settle(active, true),
      onAutoClose: () => this.#settle(active, true),
      action: spec.action
        ? {
            label: spec.action.label,
            onClick: () => this.#runAction(active),
          }
        : undefined,
    }

    switch (spec.variant ?? "info") {
      case "success":
        toast.success(spec.message, options)
        break
      case "error":
        toast.error(spec.message, options)
        break
      case "info":
      case "undo":
        toast.info(spec.message, options)
        break
    }
  }

  success(message: string, opts?: ToastOptions): void {
    this.show({ ...opts, message, variant: "success" })
  }

  error(message: string, opts?: ToastOptions): void {
    const copyAction: ToastAction = {
      label: "Copy",
      onAction: () => void copyText(message),
    }

    if (opts?.actions?.length) {
      this.show({ ...opts, message, variant: "error", actions: [...opts.actions, copyAction] })
      return
    }

    if (opts?.action) {
      this.show({ ...opts, message, variant: "error", action: undefined, actions: [opts.action, copyAction] })
      return
    }

    this.show({ ...opts, message, variant: "error", action: copyAction })
  }

  info(message: string, opts?: ToastOptions): void {
    this.show({ ...opts, message, variant: "info" })
  }

  /** Show an Undo toast. The commit runs only if the undo window lapses. */
  undo(
    message: string,
    onUndo: () => void,
    opts?: { actionLabel?: string; duration?: number; onDismiss?: () => void },
  ): void {
    this.show({
      message,
      variant: "undo",
      duration: opts?.duration,
      onDismiss: opts?.onDismiss,
      action: { label: opts?.actionLabel ?? "Undo", onAction: onUndo },
    })
  }

  /** Cmd/Ctrl+Z activates an Undo toast unless focus is in an editable field. */
  handleKeydown = (event: KeyboardEvent): void => {
    const active = this.#active
    if (!active?.action || active.action.label !== "Undo") return
    if (event.shiftKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return
    const target = event.target as HTMLElement | null
    if (target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))) return

    event.preventDefault()
    toast.dismiss(active.id)
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
    toast.dismiss(active.id)
  }

  #settle(active: ActiveToast, commit: boolean): void {
    if (active.settled) return
    active.settled = true
    if (this.#active === active) this.#active = null
    if (commit) active.onDismiss?.()
  }
}

export const toasts = new ToastStore()
