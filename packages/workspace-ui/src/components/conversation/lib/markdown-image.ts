import { getContext, setContext } from "svelte";
import type { IpcContext } from "@solus/contracts/types";
import type { HostApi } from "@solus/client-core/host-api";
import { localArtifactProtocolUrl } from "../../artifact/lib/asset-url";

const MARKDOWN_IMAGE_CONTEXT = Symbol("markdown-image-context");

interface MarkdownImageContext {
  cwd: () => string | undefined;
  serverId: () => string | undefined;
  ctx: () => IpcContext | undefined;
  isWeb: () => boolean;
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

/** Resolve agent-authored local image paths from the session working directory. */
export function markdownImageUrl(href: string, cwd: string | undefined): string {
  const path = markdownImagePath(href, cwd);
  return path ? localArtifactProtocolUrl(path) : href;
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
