/**
 * The main window keeps HTML fullscreen inside itself
 * (`disableHtmlFullscreenWindowResize`), so a browser pane guest stays in its
 * `<webview>`. The app's own fullscreen elements, such as a chat video, take
 * the screen through this decision instead.
 */

/** A browser guest's fullscreen surfaces in the app document as its `<webview>`. */
export function isAppFullscreenElement(element: { tagName: string } | null): boolean {
  return element !== null && element.tagName !== 'WEBVIEW'
}

export class HtmlFullscreen {
  /** The app, not the user, made the window fullscreen. */
  #owned = false
  /** The app asked to leave and the window has not reported `leave-full-screen` yet. */
  #leaving = false

  /** The `setFullScreen` value to apply for a renderer request, or null to change nothing. */
  request(fullscreen: boolean, windowIsFullScreen: boolean): boolean | null {
    if (fullscreen) {
      // macOS reports fullscreen until its exit animation ends, and Electron
      // queues the re-entry, so a window that is still leaving is not the user's.
      if (this.#owned || (windowIsFullScreen && !this.#leaving)) return null
      this.#owned = true
      return true
    }
    if (!this.#owned) return null
    this.#owned = false
    this.#leaving = windowIsFullScreen
    return false
  }

  windowLeftFullScreen(): void {
    // Leaving OS fullscreen another way, such as the green button, gives the
    // window back to the user.
    if (!this.#leaving) this.#owned = false
    this.#leaving = false
  }
}
