/**
 * A request for the Codebases page from outside it, held outside the page as
 * `mcpPageRequest` is, so the page takes it when it mounts or while it is
 * open: the command palette's "New codebase" opens the form one time.
 */
class CodebasesPageRequest {
  isNewAsked = $state(false)

  askNew(): void {
    this.isNewAsked = true
  }

  /** True one time for each ask. */
  takeNew(): boolean {
    const asked = this.isNewAsked
    this.isNewAsked = false
    return asked
  }
}

export const codebasesPageRequest = new CodebasesPageRequest()
