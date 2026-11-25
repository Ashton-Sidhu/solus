import { classifyMarkdownImageSource } from "@t3tools/client-runtime/markdown-images";
import {
  resolveMediaSource,
  type ResolveMediaSourceInput,
} from "@t3tools/client-runtime/media-source";

export function resolveMobileMarkdownMediaSource(href: string, input: ResolveMediaSourceInput) {
  if (href.startsWith("asset://") && href.length > 8) {
    return {
      kind: "image" as const, mimeType: "image/*", name: "Image", srcFragment: "",
      access: "environment" as const,
      resource: { _tag: "attachment" as const, attachmentId: href.slice(8) },
      reference: undefined,
    };
  }
  const media = resolveMediaSource(href, input);
  if (media?.access !== "unavailable" || !input.workspaceRoot) return media;
  const source = classifyMarkdownImageSource(href, input.workspaceRoot);
  if (source._tag !== "WorkspaceFile") return media;
  return {
    ...media,
    access: "environment" as const,
    resource: {
      _tag: "draft-workspace-file" as const,
      cwd: input.workspaceRoot,
      path: source.path,
    },
  };
}
