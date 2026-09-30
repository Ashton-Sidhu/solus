import { resolveArtifactTitle } from "@solus/contracts/work-preview";
import { exportFileName } from "../../pickers/lib/export-file-name";

/** The file an HTML block is saved to the device as: named after its own
 *  `<title>`, so a download folder of renders stays readable. */
export function htmlBlockFileName(html: string): string {
  return exportFileName(resolveArtifactTitle(undefined, html), "html", "artifact");
}

/** How a fenced ```html block reads is the document model's rule, so a reply
 *  and a document make the same choice. */
export { fenceLanguage, fenceRenderMode, isHtmlFence, type FenceRenderMode } from "@solus/document-model/fences";

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
