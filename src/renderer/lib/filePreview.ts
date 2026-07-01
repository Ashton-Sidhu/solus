import { requestInputFocus } from "./inputFocus";

export const FILE_PREVIEW_EVENT = "solus:preview-file";

export interface FilePreviewRequest {
  path: string;
  line?: number;
  tabId?: string;
}

const LINE_SUFFIX_RE = /^(.+?):(\d+)(?::\d+)?$/;

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

export function parseFileHref(href: string): FilePreviewRequest | null {
  if (!href || href.startsWith("#")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("file://")) {
    return null;
  }

  let rawPath = href;
  if (href.startsWith("file://")) {
    try {
      rawPath = new URL(href).pathname;
    } catch {
      return null;
    }
  }

  rawPath = decodePath(rawPath.split(/[?#]/, 1)[0] ?? "");
  if (!rawPath) return null;

  let line: number | undefined;
  const lineMatch = rawPath.match(LINE_SUFFIX_RE);
  if (lineMatch) {
    rawPath = lineMatch[1];
    line = Number(lineMatch[2]);
  }

  return { path: rawPath, line };
}

export function requestFilePreview(request: FilePreviewRequest) {
  window.dispatchEvent(
    new CustomEvent<FilePreviewRequest>(FILE_PREVIEW_EVENT, {
      detail: request,
    }),
  );
  requestInputFocus();
}
