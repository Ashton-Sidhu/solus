import { getContext, setContext } from "svelte";
import type { IpcContext } from "@solus/contracts/types";
import { localArtifactProtocolUrl } from "../../artifact/lib/asset-url";

const MARKDOWN_IMAGE_CONTEXT = Symbol("markdown-image-context");

interface MarkdownImageContext {
  cwd: () => string | undefined;
  serverId: () => string | undefined;
  ctx: () => IpcContext | undefined;
  isWeb: () => boolean;
}

export function setMarkdownImageContext(context: MarkdownImageContext): void {
  setContext(MARKDOWN_IMAGE_CONTEXT, context);
}

export function getMarkdownImageContext(): MarkdownImageContext | undefined {
  return getContext<MarkdownImageContext | undefined>(MARKDOWN_IMAGE_CONTEXT);
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
