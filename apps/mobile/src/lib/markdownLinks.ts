// Adapted from T3 Code apps/mobile/src/lib/markdownLinks.ts (MIT, see UPSTREAM.md).
// `markdownLinkTargets.ts` is a local copy of the T3 shared helpers it imports.
import {
  fileBasename,
  formatFilePathPosition,
  normalizeMarkdownLinkDestination,
  parseMarkdownFileLink,
} from "./markdownLinkTargets";

import { parseSessionHref } from "@solus/contracts/session-link";
import { fileMentionPath } from "./fileMentions";
import { resolveFileIcon, type FileIconToken } from "@solus/client-core/file-icons";

// T3 #21403: `src/`, `docs/My Folder/`. A bare `docs` stays a plain link, as on web.
const RELATIVE_FOLDER_LINK_PATTERN = /^(?:[A-Za-z0-9._$+@()[\]-]+(?: +[A-Za-z0-9._$+@()[\]-]+)*\/)+$/;

export type MarkdownLinkPresentation =
  | {
      readonly kind: "external";
      readonly href: string;
      readonly host: string;
    }
  | {
      readonly kind: "file";
      readonly href: string;
      readonly icon: MarkdownFileIcon;
      readonly label: string;
      readonly path: string;
      readonly line?: number;
      readonly column?: number;
    }
  | {
      /** A `session://` link an agent wrote: it opens that session's thread. */
      readonly kind: "session";
      readonly href: string;
      readonly sessionId: string;
      /** The session's host. Null when the link names none: it is on the transcript's own host. */
      readonly serverId: string | null;
    }
  | {
      readonly kind: "link";
      readonly href: string | null;
    };

export type MarkdownFileIcon = FileIconToken;

export type MarkdownLinkIcon = "github";

/**
 * Sites whose brand mark replaces the generic external-link glyph. The marks
 * are monochrome and tinted with the link color, so they follow the theme.
 */
export function resolveMarkdownLinkIcon(host: string): MarkdownLinkIcon | null {
  const hostname = host.toLowerCase();
  if (hostname === "github.com" || hostname.endsWith(".github.com")) return "github";
  return null;
}

/** Native link and media APIs have no document scheme to inherit from protocol-relative URLs. */
export function normalizeNativeMarkdownUrl(value: string): string {
  return value.startsWith("//") ? `https:${value}` : value;
}

export function resolveMarkdownLinkPresentation(href: string): MarkdownLinkPresentation {
  // An `@path` mention that Enriched recognized in user text always names a
  // file, also without an extension (`@Makefile`), as T3's mention chip does.
  const mentionPath = fileMentionPath(href);
  const normalized = normalizeMarkdownLinkDestination(mentionPath ?? href);
  try {
    const parsed = new URL(normalizeNativeMarkdownUrl(normalized));
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return {
        kind: "external",
        href: parsed.toString(),
        host: parsed.hostname,
      };
    }
  } catch {
    // Relative paths and non-URL link destinations are handled below.
  }
  const session = parseSessionHref(normalized);
  if (session) {
    return { kind: "session", href: normalized, sessionId: session.sessionId, serverId: session.serverId };
  }

  // A relative folder link (`src/`) is a file chip too: it opens the file browser at that folder.
  const target =
    parseMarkdownFileLink(normalized) ??
    (mentionPath !== null || RELATIVE_FOLDER_LINK_PATTERN.test(normalized) ? { path: normalized } : null);
  if (target) {
    return {
      kind: "file",
      href: normalized,
      icon: resolveFileIcon(target.path).token,
      label: fileBasename(formatFilePathPosition(target)),
      path: target.path,
      ...(target.line ? { line: target.line } : {}),
      ...(target.column ? { column: target.column } : {}),
    };
  }

  return {
    kind: "link",
    href: /^(?:mailto|tel):/i.test(normalized) ? normalized : null,
  };
}

