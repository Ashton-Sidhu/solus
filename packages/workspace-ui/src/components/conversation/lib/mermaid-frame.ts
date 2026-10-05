import mermaid from "mermaid";

/**
 * The entry the hidden Mermaid frame loads. Evaluated in the frame's own
 * realm, so this Mermaid builds and measures its diagrams in the frame's
 * small document rather than the workspace (see `loadMermaid`).
 */
declare global {
  interface Window {
    solusMermaid?: typeof mermaid;
  }
}

window.solusMermaid = mermaid;
