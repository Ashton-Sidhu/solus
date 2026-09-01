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

const { toasts } = await import("../../src/renderer/lib/toasts")

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
})
