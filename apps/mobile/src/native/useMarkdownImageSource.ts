import {
  AssetWorkspaceAssetNotFoundError,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useCallback } from "react";
import { resolveMobileMarkdownMediaSource } from "../lib/markdownMediaSource";
import { normalizeNativeMarkdownUrl } from "../lib/markdownLinks";
import { refreshAssetUrl } from "../state/assets";
import type { MarkdownImageSourceResolver } from "./SelectableMarkdownText.types";

const isAssetNotFound = Schema.is(AssetWorkspaceAssetNotFoundError);

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
      try {
        const uri = await refreshAssetUrl(environmentId, media.resource);
        if (!uri) throw new Error("Could not authorize Markdown image");
        return { uri };
      } catch (error) {
        if (!isAssetNotFound(error)) throw error;
        // Enriched treats an empty URI as pending. An empty image payload
        // activates its native failure placeholder without reading a file.
        return { uri: "data:image/png;base64," };
      }
    },
    [captured, environmentId, threadId, workspaceRoot],
  );
}
