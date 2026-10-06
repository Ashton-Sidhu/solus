/**
 * Provider display helpers T3 Code's `ProviderIcon` imports from its contracts
 * and client runtime (`acpRegistry.ts`, `providerInstanceDisplay.ts`, MIT, see
 * UPSTREAM.md), plus the one name Solus spells differently.
 */

const ACP_REGISTRY_CDN_HOSTNAME = "cdn.agentclientprotocol.com";

/** Solus calls Claude Code `claude-code`; T3's icon table calls it `claudeAgent`. */
export function t3ProviderName(provider: string | null | undefined): string | null | undefined {
  return provider === "claude-code" ? "claudeAgent" : provider;
}

export function providerInstanceInitials(label: string): string {
  const words = label.replace(/[_-]+/g, " ").split(/\s+/u).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return Array.from(words[0]!).slice(0, 2).join("").toUpperCase();
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0]?.toUpperCase() ?? "")
    .join("");
}

/** Allows provider icons only from the credential-free official Registry CDN origin. */
export function resolveOfficialAcpRegistryIconUrl(icon: string | null | undefined): string | null {
  if (!icon) return null;
  try {
    const url = new URL(icon);
    if (
      url.protocol !== "https:" ||
      url.hostname !== ACP_REGISTRY_CDN_HOSTNAME ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}
