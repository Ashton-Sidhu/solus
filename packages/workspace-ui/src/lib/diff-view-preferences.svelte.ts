/**
 * How the reader likes a diff drawn: stacked or side by side, and whether a
 * changed line highlights the changed words. One preference for every diff
 * surface — the diff panel and the Insights result read the same choice, so
 * changing it in one is the choice in the other.
 */

const STYLE_KEY = 'solus-diff-style'
const TOKEN_HIGHLIGHT_KEY = 'solus-diff-token-highlight'

export type DiffStyle = 'unified' | 'split'

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    // A client that refuses storage keeps the choice for this session.
  }
}

class DiffViewPreferences {
  diffStyle = $state<DiffStyle>(readStorage(STYLE_KEY) === 'split' ? 'split' : 'unified')
  /** On unless the reader turned it off. */
  tokenHighlight = $state(readStorage(TOKEN_HIGHLIGHT_KEY) !== 'off')

  setDiffStyle(style: DiffStyle): void {
    this.diffStyle = style
    writeStorage(STYLE_KEY, style)
  }

  toggleTokenHighlight(): void {
    this.tokenHighlight = !this.tokenHighlight
    writeStorage(TOKEN_HIGHLIGHT_KEY, this.tokenHighlight ? 'on' : 'off')
  }
}

export const diffViewPreferences = new DiffViewPreferences()
