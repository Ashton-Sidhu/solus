import { expect, it, vi } from "vite-plus/test";
import { faviconCandidatePaths } from "@solus/client-core/project-favicon-paths";
import { isProjectFaviconFallbackUrl } from "@t3tools/shared/projectFavicon";
import { findProjectFavicon } from "./project-favicon";

it("looks up the project icon on its host in one request", async () => {
  const root = "C:\\projects\\app";
  const signed = {
    relativeUrl: "/api/assets/signed",
    expiresAt: 1000,
    path: root + "\\favicon.svg",
  };
  const assetFindUrl = vi.fn().mockResolvedValue(signed);
  expect(await findProjectFavicon({ assetFindUrl }, root)).toEqual(signed);
  expect(assetFindUrl.mock.calls).toEqual([[undefined, { paths: faviconCandidatePaths(root) }]]);
});

it("clears the upstream thumbnail on a confirmed miss and skips projectless drafts", async () => {
  const assetFindUrl = vi.fn().mockResolvedValue(null);
  for (const root of ["/repo", "solus:new-chat"]) {
    const result = await findProjectFavicon({ assetFindUrl }, root);
    expect(isProjectFaviconFallbackUrl(result.relativeUrl)).toBe(true);
  }
  expect(assetFindUrl).toHaveBeenCalledTimes(1);
});
