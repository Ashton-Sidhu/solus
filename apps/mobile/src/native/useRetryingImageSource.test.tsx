import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { AssetWorkspaceAssetNotFoundError, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { refreshAssetUrl } from "../state/assets";
import type { MarkdownImageSourceResolver } from "./SelectableMarkdownText.types";
import { useMarkdownImageSource } from "./useMarkdownImageSource";
import { useRetryingImageSource } from "./useRetryingImageSource";

vi.mock("../state/assets", () => ({ refreshAssetUrl: vi.fn() }));

let resolveImage: ReturnType<typeof useRetryingImageSource>;

function Probe(props: { readonly resolve: MarkdownImageSourceResolver }) {
  const resolver = useRetryingImageSource(props.resolve);
  useLayoutEffect(() => {
    resolveImage = resolver;
  });
  return null;
}

it("asks the next resolver for an image the previous one could not resolve", async () => {
  const root = createRoot(document.createElement("div"));
  const offline: MarkdownImageSourceResolver = async () => {
    throw new Error("Markdown image is unavailable");
  };
  await act(async () => root.render(<Probe resolve={offline} />));
  const askedOnce = resolveImage!;

  let source: unknown = "pending";
  const answered = askedOnce({
    id: "img:0:0",
    url: "assets/shot.png",
    altText: "",
    title: "",
    placement: "inline",
  }).then((value) => {
    source = value;
  });
  await act(async () => {});
  expect(source).toBe("pending");

  const online: MarkdownImageSourceResolver = async (image) => ({
    uri: `https://host/${image.href}`,
  });
  await act(async () => root.render(<Probe resolve={online} />));
  await answered;

  expect(source).toEqual({ uri: "https://host/assets/shot.png" });
  expect(resolveImage).toBe(askedOnce);
  act(() => root.unmount());
});

it("hands a missing list image to the native failure renderer", async () => {
  const root = createRoot(document.createElement("div"));
  const environmentId = EnvironmentId.make("host");
  const threadId = ThreadId.make("thread");
  const missingPath = "/host/repo/missing.jpg";
  const availablePath = "/host/repo/available.jpg";
  const signedUrl = "https://host.test/api/assets/signed-image";
  vi.mocked(refreshAssetUrl)
    .mockRejectedValueOnce(new AssetWorkspaceAssetNotFoundError({
      resource: { _tag: "media-file", threadId, path: missingPath },
    }))
    .mockResolvedValueOnce(signedUrl);

  function ThreadImages() {
    const resolve = useMarkdownImageSource({ environmentId, threadId, workspaceRoot: "/host/repo" });
    return <Probe resolve={resolve} />;
  }

  try {
    await act(async () => root.render(<ThreadImages />));
    let missing: Awaited<ReturnType<MarkdownImageSourceResolver>> | undefined;
    let available: Awaited<ReturnType<MarkdownImageSourceResolver>> | undefined;
    await act(async () => {
      const resolve = resolveImage!;
      void resolve({
        id: "missing",
        url: missingPath,
        altText: "Activity log and panel",
        title: "",
        placement: "list",
      }).then((source) => {
        missing = source;
      });
      void resolve({
        id: "available",
        url: availablePath,
        altText: "Versions",
        title: "",
        placement: "list",
      }).then((source) => {
        available = source;
      });
    });

    // Enriched takes an empty URI as pending. An empty image payload reaches
    // the native load-failure renderer without requesting the original path.
    expect(missing).toEqual({ uri: "data:image/png;base64," });
    expect(available).toEqual({ uri: signedUrl });
  } finally {
    await act(async () => root.unmount());
    vi.mocked(refreshAssetUrl).mockReset();
  }
});
