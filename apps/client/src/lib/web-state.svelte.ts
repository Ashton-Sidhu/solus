class WebState {
  /** This page load opened a share link as a member: it shows the resource, so nothing covers it while the account loads. */
  openedFromLink = false

  serverSetupOpen: boolean = $state(false)

  openServerSetup() {
    this.serverSetupOpen = true
  }

  closeServerSetup() {
    this.serverSetupOpen = false
  }
}

export const webState = new WebState()
