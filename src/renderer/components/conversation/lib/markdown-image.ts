import { getContext, setContext } from "svelte";

const MARKDOWN_IMAGE_CONTEXT = Symbol("markdown-image-context");

interface MarkdownImageContext {
  cwd: () => string | undefined;
}

export function setMarkdownImageContext(cwd: () => string | undefined): void {
  setContext(MARKDOWN_IMAGE_CONTEXT, { cwd } satisfies MarkdownImageContext);
}

export function getMarkdownImageContext(): MarkdownImageContext | undefined {
  return getContext<MarkdownImageContext | undefined>(MARKDOWN_IMAGE_CONTEXT);
}

/** Resolve agent-authored local image paths from the session working directory. */
export function markdownImageUrl(href: string, cwd: string | undefined): string {
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
    return href;
  }

  try {
    const filePath = isFileUrl
      ? decodeURIComponent(new URL(trimmed).pathname)
      : decodeURIComponent(
          new URL(trimmed, `file://${cwd!.replace(/\/+$/, "")}/`).pathname,
        );
    return `solus-artifact://local/?p=${encodeURIComponent(filePath)}`;
  } catch {
    return href;
  }
}
