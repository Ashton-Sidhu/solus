// Adapted from T3 Code apps/mobile/src/lib/markdownMedia.ts (MIT, see UPSTREAM.md).
// T3 classifies a link into an environment asset resource. Solus asks the
// surface for the host file (a URL the host signs) or the web address to load,
// and uses the host's own media list (`mediaTypeFor`) for the kind.
import { mediaTypeFor } from "@solus/contracts/media-types";

import type {
  FilePreviewSource,
  MediaActionsSource,
  MediaReference,
} from "../components/FilePreview.types";
import type { VideoPreviewSource } from "../components/VideoPreviewModal";
import type { RootStackParamList } from "../navigation/routes";
import { fileBasename } from "./markdownLinkTargets";
import { resolveMarkdownLinkPresentation } from "./markdownLinks";

/** A host file a Markdown link names, as the surface resolves it. */
export interface MarkdownHostFile {
  /** The path on the host: copied by "Copy full path" and shown under the viewer's title. */
  readonly path: string;
  readonly relativePath?: string;
  /** Asks the host for a URL it signs for this file. */
  readonly resolveUri: () => Promise<string | null>;
  /** The file screen for this file, when the surface can open it. */
  readonly route?: RootStackParamList["File"];
}

export interface MarkdownMediaContext {
  /** The host file a path names; null when this surface cannot read host files. */
  readonly hostFile: (path: string) => MarkdownHostFile | null;
  /** The address to load a web address from: a pull request's GitHub media goes through its host. */
  readonly webUrl?: (url: string) => Promise<string>;
}

export type MarkdownMediaPreview =
  | { readonly kind: "image" | "pdf"; readonly source: FilePreviewSource }
  | { readonly kind: "video"; readonly source: VideoPreviewSource };

function webName(url: URL): string {
  return decodeURIComponent(url.pathname.split("/").pop() ?? "") || url.hostname;
}

/**
 * The viewer a Markdown link or image opens: an image, a PDF, or a video.
 * Only an explicit media reference resolves; any other link keeps its own
 * routing (the file screen or the browser). `imageEmbed` is image syntax,
 * which may name an endpoint without a recognizable extension.
 */
export function resolveMarkdownMediaPreview(
  href: string,
  context: MarkdownMediaContext,
  imageEmbed = false,
): MarkdownMediaPreview | null {
  const presentation = resolveMarkdownLinkPresentation(href);
  let reference: MediaReference;
  let name: string;
  let key: string;
  let resolveUri: () => Promise<string | null>;
  let file: RootStackParamList["File"] | undefined;
  if (presentation.kind === "external") {
    const url = new URL(presentation.href);
    reference = { kind: "url", url: presentation.href };
    name = webName(url);
    key = presentation.href;
    const { webUrl } = context;
    resolveUri = webUrl ? () => webUrl(presentation.href) : async () => presentation.href;
  } else if (presentation.kind === "file") {
    const hostFile = context.hostFile(presentation.path);
    if (hostFile === null) return null;
    reference = { kind: "file", path: hostFile.path, relativePath: hostFile.relativePath };
    name = fileBasename(hostFile.path);
    key = `host:${hostFile.path}`;
    resolveUri = hostFile.resolveUri;
    file = hostFile.route;
  } else {
    return null;
  }

  const media = mediaTypeFor(reference.kind === "url" ? new URL(reference.url).pathname : name);
  const kind = media?.kind ?? (imageEmbed ? "image" : null);
  if (kind === null) return null;
  const actionsSource: MediaActionsSource = {
    reference,
    name,
    mimeType: media?.mime ?? "image/*",
    resolveUri,
    file,
  };
  if (kind === "video") return { kind, source: { name, key, resolveUri, actionsSource } };
  return {
    kind,
    source: { kind, key, name, mimeType: actionsSource.mimeType, resolveUri, actionsSource },
  };
}
