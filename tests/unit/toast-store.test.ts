import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { ExternalToast } from "svelte-sonner"

type ToastCall = {
  kind: "default" | "success" | "error" | "info"
  message: string
  options?: ExternalToast
}

const calls: ToastCall[] = []
const dismissed: Array<number | string | undefined> = []

const toast = Object.assign(
  (message: string, options?: ExternalToast) => {
    calls.push({ kind: "default", message, options })
    return options?.id ?? calls.length
  },
  {
    success: (message: string, options?: ExternalToast) => {
      calls.push({ kind: "success" as const, message, options })
      return options?.id ?? calls.length
    },
    error: (message: string, options?: ExternalToast) => {
      calls.push({ kind: "error" as const, message, options })
      return options?.id ?? calls.length
    },
    info: (message: string, options?: ExternalToast) => {
      calls.push({ kind: "info" as const, message, options })
      return options?.id ?? calls.length
    },
    dismiss: (id?: number | string) => {
      dismissed.push(id)
      return id
    },
  },
)

mock.module("svelte-sonner", () => ({ toast }))

const { toasts } = await import("@solus/workspace-ui/lib/toasts")

describe("toast service", () => {
  beforeEach(() => {
    toasts.dismiss()
    calls.length = 0
    dismissed.length = 0
  })

  test("renders variants through Sonner's standard toast API", () => {
    toasts.success("Saved")

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ kind: "success", message: "Saved" })
    expect(calls[0].options?.duration).toBeUndefined()
  })

  test("uses the description line for supporting detail", () => {
    toasts.error("Couldn't save", { description: "Permission denied" })

    expect(calls[0]).toMatchObject({
      kind: "error",
      message: "Couldn't save",
      options: { description: "Permission denied" },
    })
  })

  test("does not infer structure from punctuation in the title", () => {
    toasts.info("Host found: laptop", { description: "Ready to connect" })

    expect(calls[0]).toMatchObject({
      kind: "info",
      message: "Host found: laptop",
      options: { description: "Ready to connect" },
    })
  })

  test("maps two actions to Sonner's standard action and cancel buttons", () => {
    const activated: string[] = []
    toasts.show({
      message: "Choose an action",
      actions: [
        { label: "Open", onAction: () => activated.push("open") },
        { label: "Copy", onAction: () => activated.push("copy") },
      ],
    })

    const options = calls[0].options
    expect(options?.action).toMatchObject({ label: "Open" })
    expect(options?.cancel).toMatchObject({ label: "Copy" })

    if (!options?.action || typeof options.action === "function") throw new Error("missing action")
    options.action.onClick({} as MouseEvent)
    expect(activated).toEqual(["open"])
  })

  test("keeps deferred dismissal semantics for standard toasts", () => {
    let committed = 0
    toasts.undo("Deleted", () => {}, { onDismiss: () => committed++ })

    calls[0].options?.onAutoClose?.({} as never)

    expect(committed).toBe(1)
  })

  test("uses Sonner's ID and only dismisses the matching active toast", () => {
    const id = toasts.info("Connected")

    expect(toasts.isActive(id)).toBe(true)
    expect(toasts.dismiss("another-toast")).toBe(false)
    expect(toasts.dismiss(id)).toBe(true)
    expect(dismissed).toEqual([id])
  })

  test("keeps a progress toast on screen with a close button while work runs", () => {
    const progress = toasts.progress("Committing…")

    // Sonner drops its close button on loading toasts, so this must stay a
    // default toast wearing the spinner class.
    expect(calls[0]).toMatchObject({ kind: "default", message: "Committing…" })
    expect(calls[0].options?.class).toBe("solus-toast-progress")
    expect(calls[0].options?.closeButton).toBe(true)
    expect(calls[0].options?.duration).toBe(Number.POSITIVE_INFINITY)

    progress.dismiss()
    expect(dismissed).toEqual([calls[0].options?.id ?? 1])
  })

  test("reuses the progress slot so the result replaces the spinner in place", () => {
    const progress = toasts.progress("Committing…")
    const slotId = calls[0].options?.id ?? 1

    progress.update("Pushing…")
    expect(calls[1]).toMatchObject({ kind: "default", message: "Pushing…" })
    expect(calls[1].options?.id).toBe(slotId)

    progress.success("Committed and pushed", { description: "feat: ship it" })
    expect(calls[2]).toMatchObject({
      kind: "success",
      message: "Committed and pushed",
      options: { id: slotId, description: "feat: ship it", closeButton: true },
    })
    // The spinner must not survive into the success toast.
    expect(calls[2].options?.class).toBeUndefined()
    expect(calls).toHaveLength(3)
  })

  test("a failed operation ends the progress toast as an error", () => {
    const progress = toasts.progress("Opening pull request…")
    progress.error("Git action failed", { description: "gh: not authenticated" })

    expect(calls[1]).toMatchObject({
      kind: "error",
      message: "Git action failed",
      options: { description: "gh: not authenticated", closeButton: true },
    })
  })
})
