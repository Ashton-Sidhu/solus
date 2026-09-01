/**
 * Whether a stage edge is being dragged right now.
 *
 * The guest is painted over the stage by the app-root layer, so a drag that
 * leaves the handle passes under a `<webview>` — a separate render process that
 * takes the pointer and never gives the events back. While a drag is live the
 * layer stops accepting pointer events, which keeps the whole gesture in this
 * document until the user lets go.
 */
export const stageDrag = $state({ active: false })
