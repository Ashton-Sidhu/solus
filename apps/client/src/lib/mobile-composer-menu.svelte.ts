/**
 * The phone's Add-to-chat sheet, opened from whichever composer is on screen.
 *
 * The sheet is rendered once by the mobile shell, but two composers open it —
 * the started-session dock and a session draft's own bar, which lives inside
 * the routed surface rather than the shell. A module flag lets the draft's `+`
 * reach the shell's sheet without threading a callback through the pane router.
 */
export const mobileComposerMenu = $state({ open: false })
