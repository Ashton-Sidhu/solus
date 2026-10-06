import { mediaTypeFor } from "./media-types";

/**
 * Local images in agent HTML. An agent points a page at a screenshot it just
 * took by its absolute path on the host. The sandbox frame cannot load that
 * path: it names a file on the host, the client may be on another device, and
 * the frame's CSP loads images only from data:, blob:, and https:. So each
 * file is read from the host and written into the page as a data: URL: by the
 * client for an HTML block, and by the server for a preview or a saved
 * artifact. The page is then self-contained.
 */

/** `src="…"` on an element or in a script, and `url(…)` in a stylesheet. */
const SRC_VALUE = /(\bsrc\s*=\s*)(["'])(.*?)\2/gi;
const CSS_URL = /(\burl\(\s*)(["']?)([^"')]*?)\2(\s*\))/gi;

/** A file larger than this stays as written: a data: URL that size would make
 *  every save and every reload of the page slow. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function rewriteReferences(html: string, rewrite: (reference: string) => string | undefined): string {
  return html
    .replace(SRC_VALUE, (match, prefix: string, quote: string, reference: string) => {
      const next = rewrite(reference);
      return next === undefined ? match : `${prefix}${quote}${next}${quote}`;
    })
    .replace(CSS_URL, (match, prefix: string, quote: string, reference: string, suffix: string) => {
      const next = rewrite(reference);
      return next === undefined ? match : `${prefix}${quote}${next}${quote}${suffix}`;
    });
}

/** The host path a reference names when it is a local image: an absolute path
 *  or a file: URL with an image extension. A relative path has no base in a
 *  sandboxed page, so it is not read as a host file. */
export function localImagePath(reference: string): string | null {
  let path: string;
  if (/^file:\/\//i.test(reference)) {
    try {
      path = decodeURIComponent(new URL(reference).pathname);
    } catch {
      return null;
    }
  } else if (reference.startsWith("/") && !reference.startsWith("//")) {
    path = reference;
  } else {
    return null;
  }
  return mediaTypeFor(path)?.kind === "image" ? path : null;
}

/** Each local image reference in the markup, with the host path it names. */
export function localImageReferences(html: string): Map<string, string> {
  const references = new Map<string, string>();
  rewriteReferences(html, (reference) => {
    const path = localImagePath(reference);
    if (path) references.set(reference, path);
    return undefined;
  });
  return references;
}

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** The markup with its local images written in, and the paths that could not be. */
export interface InlinedHtml {
  html: string;
  /** Host paths that failed to load or were too large; they stay as written. */
  missing: string[];
}

/**
 * The markup with every local image it can load written in as a data: URL.
 * An image that fails to load, or is too large, stays as written, so the page
 * still renders and only that image is missing.
 */
export async function inlineLocalImages(
  html: string,
  loadImage: (path: string) => Promise<Blob | null>,
): Promise<InlinedHtml> {
  const references = localImageReferences(html);
  if (references.size === 0) return { html, missing: [] };
  const urls = new Map<string, string>();
  const missing: string[] = [];
  await Promise.all(
    [...references].map(async ([reference, path]) => {
      try {
        const image = await loadImage(path);
        if (!image || image.size > MAX_IMAGE_BYTES) {
          missing.push(path);
          return;
        }
        // The extension names the type: the host may serve a file generically.
        const mime = mediaTypeFor(path)!.mime;
        urls.set(reference, `data:${mime};base64,${base64Of(new Uint8Array(await image.arrayBuffer()))}`);
      } catch {
        // The host refused or the file is gone; the reference stays as written.
        missing.push(path);
      }
    }),
  );
  return {
    html: urls.size === 0 ? html : rewriteReferences(html, (reference) => urls.get(reference)),
    missing: missing.sort(),
  };
}
