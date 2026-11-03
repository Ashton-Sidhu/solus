/** A toast message too long to read in the toast, opened in the toast message
 *  dialog that the Toaster mounts. */
export interface OpenToastMessage {
  title: string
  text: string
}

class ToastMessageDialog {
  /** The message on screen, or null when the dialog is closed. */
  message = $state<OpenToastMessage | null>(null)

  open(message: OpenToastMessage): void {
    this.message = message
  }

  close(): void {
    this.message = null
  }
}

export const toastMessageDialog = new ToastMessageDialog()
