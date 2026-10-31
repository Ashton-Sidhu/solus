export type WebLinkIcon =
  | { kind: "github" }
  | { kind: "favicon"; url: string }
  | { kind: "globe" };

/** Web links use a brand mark, a public favicon, or a theme-colored globe.
 * Only the public hostname goes to Google, never a path or local address. */
export function webLinkIcon(href: string): WebLinkIcon | null {
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (hostname === "github.com" || hostname.endsWith(".github.com")) return { kind: "github" };
    // IP literals and local names cannot have a public favicon. Exclude them
    // before constructing the third-party request, including IPv6 literals.
    if (
      !hostname.includes(".") || hostname.includes(":") || /^[\d.]+$/.test(hostname) ||
      /\.(?:localhost|local|internal|test|invalid|example|home|lan)$/.test(hostname)
    ) return { kind: "globe" };
    return {
      kind: "favicon",
      url: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=32`,
    };
  } catch {
    return null;
  }
}
