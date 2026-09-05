import { needsSandbox } from "../../artifact/lib/artifact-view";

/**
 * How a fenced ```html block reads in a reply.
 *
 * - **block** — a page to look at. It renders live in the sandbox frame.
 * - **snippet** — code to read. It stays a code block, with a Render action.
 *
 * The content decides, because an agent explaining a template bug pastes a
 * `<div>` to be read and rendering it would show an empty frame where the code
 * was. A fragment that carries its own styles or behaviour was written to be
 * looked at. The info string overrides the test in either direction, for the
 * cases it gets wrong: ```html render and ```html source.
 */
export type FenceRenderMode = "block" | "snippet";

/** The words a fence's info string carries: the language, then any directive. */
function infoWords(info: string | undefined): string[] {
  return (info ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** The language a fence declares — the first word of its info string, so a
 *  directive after it never reaches a highlighter or a language label. */
export function fenceLanguage(info: string | undefined): string {
  return infoWords(info)[0] ?? "";
}

export function isHtmlFence(info: string | undefined): boolean {
  return fenceLanguage(info) === "html";
}

export function fenceRenderMode(
  info: string | undefined,
  html: string,
): FenceRenderMode {
  const directives = infoWords(info).slice(1);
  if (directives.includes("render")) return "block";
  if (directives.includes("source")) return "snippet";
  return needsSandbox(html) ? "block" : "snippet";
}

/** Whether the fence's closing delimiter has arrived. While a message streams,
 *  a growing fence must render as source: swapping to a frame per token would
 *  rebuild an iframe at the rate the model writes. Read from the token's own
 *  text rather than a streaming flag, so every surface gets the rule without
 *  having to plumb one down. */
export function fenceIsSettled(raw: string | undefined): boolean {
  if (!raw) return false;
  const open = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(raw);
  // An indented code block has no delimiter to wait for.
  if (!open) return true;
  const marker = open[1][0];
  const width = open[1].length;
  const body = raw.slice(open[0].length);
  return new RegExp(`(?:^|\\n)[ \\t]{0,3}[${marker}]{${width},}[ \\t]*(?:\\n|$)`)
    .test(body);
}
