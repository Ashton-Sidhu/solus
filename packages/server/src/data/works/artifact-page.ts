import { readArtifactPageAttachmentId } from '@solus/contracts/artifact-page'
import { SOLUS_THEME_SNAPSHOT, sandboxThemeCss, wrapSandboxDocument } from '@solus/contracts/artifact-sandbox'
import type { AssetCreateUrlResult } from '@solus/contracts/rpc'
import type { RecordScope } from '../../admission/principal'
import { createPageAssetUrl, writeAssetBytes } from '../assets/assets'
import { Work } from './work'

/**
 * One saved artifact version as a page a phone loads from a signed URL
 * (`docs/plans/mobile-artifact-pages.md`). The page is the sandbox document
 * the host measured the version in, so the phone's frame fits it.
 */

// The T3 phone client sends its theme in the URL fragment before the first
// paint, and later as an MCP Apps host-context message
// (`apps/mobile/packages/shared/src/htmlRender.ts`). This bridge applies both
// over the light theme the document starts with. In a top-level page, a link
// opens a new window, which the phone gives to its browser.
const PHONE_BRIDGE = `<script>(function(){
  var d = document, s = d.createElement("style");
  s.id = "solus-phone-theme";
  s.textContent = "html{overflow:auto}";
  (d.head || d.documentElement).appendChild(s);
  function apply(appearance, variables){
    if (!variables || typeof variables !== "object") return;
    var css = ":root{color-scheme:" + (appearance === "light" ? "light" : "dark") + ";";
    for (var k in variables) if (/^--[a-z0-9-]+$/.test(k)) css += k + ":" + String(variables[k]).replace(/[;{}<>]/g, "") + ";";
    s.textContent = css + "}html{overflow:auto}";
  }
  var m = /[#&]t3-theme=([^&]*)/.exec(location.hash);
  if (m) {
    try { var t = JSON.parse(decodeURIComponent(m[1])); apply(t && t.appearance, t && t.variables); } catch (e) {}
    try { history.replaceState(history.state, "", location.pathname + location.search); } catch (e) {}
  }
  window.addEventListener("message", function(e){
    var data = e.data, p = data && data.params;
    if (data && data.jsonrpc === "2.0" && data.method === "ui/notifications/host-context-changed" && p && p.styles) apply(p.theme, p.styles.variables);
  });
  if (parent !== window) return;
  d.addEventListener("click", function(e){
    var path = e.composedPath(), link = null;
    for (var i = 0; i < path.length && !link; i++) if (path[i] && path[i].matches && path[i].matches("a[href]")) link = path[i];
    if (!e.isTrusted || !link || link.getAttribute("href").charAt(0) === "#") return;
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener");
  }, true);
})();</script>`

export function artifactPageDocument(html: string): string {
  const themeCss = sandboxThemeCss(false, (variable) => SOLUS_THEME_SNAPSHOT.light[variable])
  return wrapSandboxDocument(PHONE_BRIDGE + html, themeCss)
}

/** The body of one saved version of an artifact work in `scope`, or null when it has none. */
async function artifactVersionBody(scope: RecordScope, workId: string, contentVersion: number): Promise<string | null> {
  const work = await Work.find(scope, workId)
  if (work?.type !== 'artifact') return null
  if (work.contentVersion === contentVersion) return work.content
  const revision = (await work.revisions()).find((entry) => entry.sourceContentVersion === contentVersion)
  return revision ? (await work.revision(revision.revisionId)).content : null
}

/** Signs a URL for the page of the artifact version `attachmentId` names, or
 *  answers null when the id names no artifact version. */
export async function createArtifactPageUrl(scope: RecordScope, attachmentId: string): Promise<AssetCreateUrlResult | null> {
  const version = readArtifactPageAttachmentId(attachmentId)
  if (!version) return null
  const html = await artifactVersionBody(scope, version.workId, version.contentVersion)
  if (html === null) throw new Error('This artifact version is not on this host.')
  const stored = await writeAssetBytes(Buffer.from(artifactPageDocument(html)), 'html')
  return createPageAssetUrl(stored.id)
}
