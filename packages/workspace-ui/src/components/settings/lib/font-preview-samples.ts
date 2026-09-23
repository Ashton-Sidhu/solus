/** Sample copy for the typography previews in Settings → Appearance. Each
 *  sample is written for the surface it stands in for, and carries the glyphs a
 *  face is judged on: mixed digits, `0O` and `1lI`, and a few descenders. */

export const INTERFACE_PREVIEW = {
  title: "Refactor the session store",
  body: "Move stale-guard logic out of the workspace context into a colocated store, then re-run the 14 focused tests before opening the pull request.",
  meta: "Updated 09:41 · 3 files · 128 lines",
} as const;

export const PROMPT_PREVIEW =
  "Fix the flaky test in surface.test.ts and align the header with SettingsPanels.svelte before shipping.";

export const DOCUMENT_PREVIEW = {
  heading: "Why the cache is keyed by host",
  body: "A client can be connected to several hosts at once, and each host owns its own sessions. Keying the cache by host keeps a reconnect from showing one host's transcript under another's tab.",
} as const;

export const CODE_PREVIEW = [
  "export function formatUser(user: User) {",
  "  return `${user.name} <${user.email}>`; // 0O 1lI",
  "}",
].join("\n");
