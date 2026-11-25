import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback } from "react";
import { resolveMobileMarkdownMediaSource } from "../lib/markdownMediaSource";
import { normalizeNativeMarkdownUrl } from "../lib/markdownLinks";
import { refreshAssetUrl } from "../state/assets";
import type { MarkdownImageSourceResolver } from "./SelectableMarkdownText.types";

export function useMarkdownImageSource(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly workspaceRoot: string | null;
  readonly captured?: boolean;
}): MarkdownImageSourceResolver {
  const { environmentId, threadId, workspaceRoot, captured } = props;
  return useCallback(
    async (image) => {
      const media = resolveMobileMarkdownMediaSource(image.href, {
        threadId: threadId ?? undefined,
        workspaceRoot,
        imageEmbed: true,
      });
      if (media?.access === "direct") return { uri: normalizeNativeMarkdownUrl(media.uri) };
      if (captured || !media || media.access !== "environment")
        throw new Error("Markdown image is unavailable");
      const uri = await refreshAssetUrl(environmentId, media.resource);
      if (!uri) throw new Error("Could not authorize Markdown image");
      return { uri };
    },
    [captured, environmentId, threadId, workspaceRoot],
  );
}
