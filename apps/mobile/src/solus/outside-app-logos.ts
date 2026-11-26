import type { ImageSourcePropType } from "react-native";

/**
 * The logo of each cloud app the phone offers, by guide id, as T3 Code's
 * picker shows them (its `components/mcp/logos`, MIT). The phone offers only
 * apps that run in the cloud, so the computer apps have no entry here.
 */
const LOGOS = {
  claude: require("../../assets/outside-apps/claude.png"),
  chatgpt: require("../../assets/outside-apps/chatgpt.png"),
  "grok-bot": require("../../assets/outside-apps/grokbot.png"),
  poke: require("../../assets/outside-apps/poke.png"),
  muse: require("../../assets/outside-apps/muse.png"),
  instinct: require("../../assets/outside-apps/instinct.png"),
} satisfies Record<string, ImageSourcePropType>;

const hasLogo = (guideId: string): guideId is keyof typeof LOGOS => Object.hasOwn(LOGOS, guideId);

/** The logo of a guide, or null for an app the phone has no logo for. */
export function outsideAppLogo(guideId: string): ImageSourcePropType | null {
  return hasLogo(guideId) ? LOGOS[guideId] : null;
}
