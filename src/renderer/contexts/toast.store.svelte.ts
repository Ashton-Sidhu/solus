/** Visual tone of a toast — drives its icon and accent colour. */
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
  /** Called when the toast auto-dismisses, is replaced, or is manually dismissed.
   *  NOT called when the user activates {@link action}. */
  onDismiss?: () => void
}

interface ActiveToast extends ToastSpec {
  id: number
  variant: ToastVariant
}

/** Options accepted by the convenience helpers (everything except the message
 *  and the variant, which the helper sets). */
type ToastOptions = Omit<ToastSpec, "message" | "variant">

/** App-wide toast queue. One toast shows at a time, top-right of the active shell.
 *  A module singleton (not context-injected) so non-component code — e.g. the
 *  session store — can raise toasts too. */
class ToastStore {
  current = $state<ActiveToast | null>(null)
  #seq = 0

  /** Show a toast, committing (dismissing) any toast it replaces. */
  show(spec: ToastSpec): void {
    this.current?.onDismiss?.()
    this.current = { ...spec, variant: spec.variant ?? "info", id: ++this.#seq }
  }

  /** Convenience: a success toast ("Saved", "Copied", …). */
  success(message: string, opts?: ToastOptions): void {
    this.show({ ...opts, message, variant: "success" })
  }

  /** Convenience: an error toast ("Failed to save", …). */
  error(message: string, opts?: ToastOptions): void {
    this.show({ ...opts, message, variant: "error" })
  }

  /** Convenience: a neutral informational / notification toast. */
  info(message: string, opts?: ToastOptions): void {
    this.show({ ...opts, message, variant: "info" })
  }

  /** Convenience: an "X deleted — Undo" toast. `onUndo` runs if the user undoes;
   *  `onDismiss` (the commit) runs if the undo window lapses instead. */
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

  /** The user activated the current toast's action (e.g. Undo). */
  runAction(): void {
    const t = this.current
    this.current = null
    t?.action?.onAction()
  }

  /** The current toast auto-dismissed or was manually dismissed. */
  dismiss(): void {
    const t = this.current
    this.current = null
    t?.onDismiss?.()
  }
}

export const toasts = new ToastStore()
