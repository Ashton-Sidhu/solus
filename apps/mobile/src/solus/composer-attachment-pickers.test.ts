import { beforeEach, expect, it, vi } from "vite-plus/test";
import {
  pickComposerFiles,
  pickComposerMedia,
  pastedComposerImages,
} from "@solus-mobile/features/threads/composer-attachment-pickers";
import { attachmentKind } from "@solus/contracts/media-types";

const native = vi.hoisted(() => ({
  pickMedia: vi.fn(),
  pickDocuments: vi.fn(),
  renderPhoto: vi.fn(),
}));

vi.mock("expo-image-picker", () => ({ launchImageLibraryAsync: native.pickMedia }));
vi.mock("expo-document-picker", () => ({ getDocumentAsync: native.pickDocuments }));
vi.mock("expo-file-system", () => ({
  File: class {
    constructor(readonly uri: string) {}
    size = 100;
    type = "";
  },
}));
vi.mock("../lib/composerMediaLibrary", () => ({
  openComposerMediaLibrary: () => native.pickMedia(),
}));
vi.mock("../lib/composerImageFit", () => ({ renderPhoto: native.renderPhoto }));

beforeEach(() => vi.resetAllMocks());

it("prepares a HEIC photo as a JPEG before it enters the upload strip", async () => {
  native.pickMedia.mockResolvedValue({
    canceled: false,
    assets: [{ type: "image", uri: "file:///photo.heic", fileName: "photo.HEIC", mimeType: "image/heic" }],
  });
  native.renderPhoto.mockResolvedValue({ uri: "file:///preview.jpg" });

  const [file] = await pickComposerMedia();
  expect(file).toEqual({
    uri: "file:///preview.jpg",
    name: "photo.jpg",
    mimeType: "image/jpeg",
    size: 100,
  });
  expect(attachmentKind(file!).type).toBe("image");
});

it("keeps an original PNG and MOV when the picker reports a generic MIME type", async () => {
  native.pickMedia.mockResolvedValue({
    canceled: false,
    assets: [
      { type: "image", uri: "file:///photo.png", mimeType: "application/octet-stream" },
      { type: "video", uri: "file:///clip.mov", fileName: "clip", mimeType: "application/octet-stream" },
    ],
  });

  const [photo, video] = await pickComposerMedia();
  expect(photo).toMatchObject({ uri: "file:///photo.png", mimeType: "image/png" });
  expect(video).toMatchObject({ uri: "file:///clip.mov", name: "clip.mov", mimeType: "video/quicktime" });
  expect(attachmentKind(video!).isVideo).toBe(true);
  expect(native.renderPhoto).not.toHaveBeenCalled();
});

it("uses the photo library's image kind when the source has no MIME type or extension", async () => {
  native.pickMedia.mockResolvedValue({
    canceled: false,
    assets: [{ type: "image", uri: "file:///photo" }],
  });
  native.renderPhoto.mockResolvedValue({ uri: "file:///preview.jpg" });

  expect(await pickComposerMedia()).toMatchObject([
    { name: "photo.jpg", uri: "file:///preview.jpg", mimeType: "image/jpeg" },
  ]);
});

it("uses T3 media detection for generic files and respects definite document types", async () => {
  native.pickDocuments.mockResolvedValue({
    canceled: false,
    assets: [
      { name: "photo.png", uri: "file:///photo", mimeType: "application/octet-stream" },
      { name: "video.mkv", uri: "file:///video", mimeType: null },
      { name: "paper.png", uri: "file:///document", mimeType: "application/pdf" },
    ],
  });

  expect((await pickComposerFiles()).map(attachmentKind)).toMatchObject([
    { type: "image", mimeType: "image/png" },
    { type: "file", mimeType: "video/x-matroska", isVideo: true },
    { type: "file", mimeType: "application/pdf", isVideo: false },
  ]);
});

it("prepares HEIC from Files and from native paste before sending it", async () => {
  native.pickDocuments.mockResolvedValue({
    canceled: false,
    assets: [{ name: "photo.heic", uri: "file:///photo.heic", mimeType: "image/heic" }],
  });
  native.renderPhoto.mockResolvedValue({ uri: "file:///preview.jpg" });

  for (const files of [await pickComposerFiles(), await pastedComposerImages(["file:///photo.heic"])]) {
    expect(files).toMatchObject([
      { name: "photo.jpg", uri: "file:///preview.jpg", mimeType: "image/jpeg" },
    ]);
  }
});
