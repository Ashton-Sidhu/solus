import { getContext, setContext } from "svelte";
import type { IpcContext } from "@solus/contracts/types";
import type { HostApi } from "@solus/client-core/host-api";
import { videoMimeType } from "@solus/contracts/media-types";

const MARKDOWN_IMAGE_CONTEXT = Symbol("markdown-image-context");

export interface MarkdownImageContext {
  cwd: () => string | undefined;
  serverId: () => string | undefined;
  ctx: () => IpcContext | undefined;
  api: () => HostApi | undefined;
}

export function setMarkdownImageContext(context: MarkdownImageContext): void {
  setContext(MARKDOWN_IMAGE_CONTEXT, context);
}

export function getMarkdownImageContext(): MarkdownImageContext | undefined {
  return getContext<MarkdownImageContext | undefined>(MARKDOWN_IMAGE_CONTEXT);
}

const ASSET_URI = /^asset:\/\/([a-f0-9]{64}\.[a-z0-9][a-z0-9+_-]{0,15})$/i;

export function markdownAssetId(href: string): string | null {
  return href.trim().match(ASSET_URI)?.[1].toLowerCase() ?? null;
}

/** Resolve an agent-authored local URL to an absolute host-side path. */
export function markdownImagePath(href: string, cwd: string | undefined): string | null {
  const trimmed = href.trim();
  const isFileUrl = /^file:/i.test(trimmed);
  if (
    !trimmed ||
    ((!cwd || cwd === "~") && !isFileUrl) ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("?") ||
    (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !isFileUrl)
  ) {
    return null;
  }

  try {
    const filePath = isFileUrl
      ? decodeURIComponent(new URL(trimmed).pathname)
      : decodeURIComponent(
          new URL(trimmed, `file://${cwd!.replace(/\/+$/, "")}/`).pathname,
        );
    return filePath;
  } catch {
    return null;
  }
}

/**
 * Whether a Markdown image is a video, so it plays instead of breaking in an
 * `<img>`. Read from the resolved host path or asset id when there is one, and
 * from the URL's path otherwise; the extension is the only evidence Markdown
 * carries.
 */
export function isMarkdownVideo(
  href: string,
  path: string | null,
  assetId: string | null,
): boolean {
  let name = assetId ?? path;
  if (name === null) {
    try {
      name = new URL(href.trim()).pathname;
    } catch {
      name = href.trim().split(/[?#]/, 1)[0];
    }
  }
  return videoMimeType({ name }) !== null;
}

/**
 * The scroll position that keeps the point a reader clicked under the pointer
 * when a fitted image grows to its actual size. `fraction` is where on the
 * fitted image the click landed (0–1); `pointerOffset` is how far the pointer
 * is from the viewer's leading edge. One axis at a time.
 */
export function zoomScrollOffset(
  fraction: number,
  zoomedSize: number,
  pointerOffset: number,
): number {
  return Math.max(0, fraction * zoomedSize - pointerOffset);
}
