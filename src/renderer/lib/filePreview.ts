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

// File previews render in the editor's pane system. From the pill window the
// request hops windows: stash it under a shared localStorage key (both Electron
// windows share the origin), then ask main to surface the editor window, which
// consumes the key on mount or via the cross-window `storage` event.
const PENDING_PREVIEW_KEY = "solus-pending-file-preview";
const PENDING_PREVIEW_TTL_MS = 30_000;

function isPillWindow(): boolean {
  try {
    if (window.solus.getPlatform() === "web") return false;
    return new URLSearchParams(window.location.search).get("mode") !== "editor";
  } catch {
    return false;
  }
}

export function requestFilePreview(request: FilePreviewRequest) {
  if (isPillWindow()) {
    try {
      // tabId is pill-scoped and meaningless in the editor window — drop it.
      const { tabId: _tabId, ...handoff } = request;
      localStorage.setItem(
        PENDING_PREVIEW_KEY,
        JSON.stringify({ ...handoff, ts: Date.now() }),
      );
    } catch {}
    void window.solus.switchMode("editor");
    return;
  }
  window.dispatchEvent(
    new CustomEvent<FilePreviewRequest>(FILE_PREVIEW_EVENT, {
      detail: request,
    }),
  );
  requestInputFocus();
}

/** Editor window: deliver preview requests handed off from the pill window —
 *  a fresh pending one at mount (the switch may have just created this window)
 *  and any that arrive later while this window stays open. */
export function consumePendingFilePreview(
  onRequest: (request: FilePreviewRequest) => void,
): () => void {
  const consume = () => {
    try {
      const raw = localStorage.getItem(PENDING_PREVIEW_KEY);
      if (!raw) return;
      localStorage.removeItem(PENDING_PREVIEW_KEY);
      const parsed = JSON.parse(raw);
      if (typeof parsed?.path !== "string") return;
      if (Date.now() - (parsed.ts ?? 0) > PENDING_PREVIEW_TTL_MS) return;
      const { ts: _ts, ...request } = parsed;
      onRequest(request as FilePreviewRequest);
    } catch {}
  };
  consume();
  const onStorage = (e: StorageEvent) => {
    if (e.key === PENDING_PREVIEW_KEY && e.newValue) consume();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
