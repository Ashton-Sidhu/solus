import chatgptLogo from './logos/chatgpt.png'
import claudeLogo from './logos/claude.png'
import codexMark from './logos/codex.png'
import cursorMark from './logos/cursor.png'
import grokBotLogo from './logos/grokbot.png'
import hermesLogo from './logos/hermes.png'
import instinctLogo from './logos/instinct.png'
import museLogo from './logos/muse.png'
import openClawLogo from './logos/openclaw.png'
import pokeLogo from './logos/poke.png'

/**
 * The logo of each app in the picker, by guide id, as T3 Code shows them
 * (its `components/mcp/logos`, MIT). Cursor and Codex have no app logo there:
 * Solus shows their white marks on a dark tile, as their own app icons are.
 */
export interface OutsideAppLogo {
  src: string
  /** The mark is white: it needs the dark tile behind it. */
  onDark: boolean
}

const LOGOS = {
  claude: { src: claudeLogo, onDark: false },
  chatgpt: { src: chatgptLogo, onDark: false },
  'grok-bot': { src: grokBotLogo, onDark: false },
  poke: { src: pokeLogo, onDark: false },
  muse: { src: museLogo, onDark: false },
  instinct: { src: instinctLogo, onDark: false },
  cursor: { src: cursorMark, onDark: true },
  'claude-code': { src: claudeLogo, onDark: false },
  codex: { src: codexMark, onDark: true },
  openclaw: { src: openClawLogo, onDark: false },
  'hermes-agent': { src: hermesLogo, onDark: false },
} satisfies Record<string, OutsideAppLogo>

const hasLogo = (guideId: string): guideId is keyof typeof LOGOS => Object.hasOwn(LOGOS, guideId)

/** The logo of a guide; null for an app Solus has no logo for, which shows its first letter. */
export function outsideAppLogo(guideId: string): OutsideAppLogo | null {
  return hasLogo(guideId) ? LOGOS[guideId] : null
}
