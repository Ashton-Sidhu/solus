// Adapted from T3 Code apps/mobile/src/lib/mediaActions.test.ts (MIT, see apps/mobile/UPSTREAM.md).
// Long-pressing an image offers "Save image" only where the save needs no share
// sheet: iOS and Android 10+, for formats Photos imports. The save downloads the
// original bytes to a cache folder, hands that file to the native module, and
// removes the folder, so saved images do not pile up in the app cache.
import { beforeEach, describe, expect, it, mock } from "bun:test";

const platform: { OS: string; Version: number | string } = { OS: "ios", Version: "26.0" };
const alerts: [string, string][] = [];
mock.module("react-native", () => ({
  Platform: platform,
  Alert: { alert: (title: string, message: string) => alerts.push([title, message]) },
}));
// The hook runs outside a renderer: state updates are dropped, which is enough
// to read its menu and run an action.
mock.module("react", () => ({
  useRef: <T,>(current: T) => ({ current }),
  useState: <T,>(initial: T) => [initial, () => {}],
  useEffect: () => {},
}));
mock.module("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: () => {} }) }));
mock.module("../../apps/mobile/src/lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: () => {} }));

const removed: string[] = [];
const downloads: string[] = [];
let failDownload = false;
class FakeDirectory {
  readonly uri: string;
  readonly name: string;
  exists = false;
  constructor(parent: { uri: string } | string, name: string) {
    this.uri = `${typeof parent === "string" ? parent : parent.uri}/${name}`;
    this.name = name;
  }
  create() {
    this.exists = true;
  }
  list() {
    return [];
  }
  delete() {
    removed.push(this.uri);
    this.exists = false;
  }
}
class FakeFile {
  readonly uri: string;
  readonly name: string;
  constructor(parent: { uri: string }, name: string) {
    this.uri = `${parent.uri}/${name}`;
    this.name = name;
  }
  static async downloadFileAsync(url: string, file: FakeFile) {
    if (failDownload) throw new Error("offline");
    downloads.push(`${url} -> ${file.uri}`);
  }
}
mock.module("expo-file-system", () => ({
  Directory: FakeDirectory,
  File: FakeFile,
  Paths: { cache: "file:///cache" },
}));
mock.module("expo-crypto", () => ({ randomUUID: () => "00000000-0000-4000-8000-000000000000" }));

const saves: [string, string, string][] = [];
let saveError: Error | null = null;
mock.module("expo", () => ({
  requireNativeModule: (name: string) => {
    if (name !== "SolusFilePreview") throw new Error(`unexpected module ${name}`);
    return {
      saveImageToLibrary: async (uri: string, mimeType: string, fileName: string) => {
        if (saveError) throw saveError;
        saves.push([uri, mimeType, fileName]);
      },
    };
  },
}));

const { useMediaActions } = await import("../../apps/mobile/src/lib/mediaActions");
const { canSaveImageToLibrary } = await import("../../apps/mobile/src/lib/saveImageToLibrary");

function imageSource(mimeType = "image/png") {
  return {
    reference: { kind: "file" as const, path: "/repo/shot.png" },
    name: "shot.png",
    mimeType,
    resolveUri: async () => "https://host.test/signed/shot.png",
  };
}

function menu(mimeType?: string) {
  return useMediaActions(imageSource(mimeType)).actions.map(({ id, title }) => [id, title]);
}

/** Resolves once the action's alert or save settles; the hook gives no promise. */
async function settle() {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  platform.OS = "ios";
  platform.Version = "26.0";
  alerts.length = 0;
  removed.length = 0;
  downloads.length = 0;
  saves.length = 0;
  failDownload = false;
  saveError = null;
});

describe("image menu", () => {
  it("offers Save image and a plain Share on iOS and Android 10+", () => {
    expect(menu()).toContainEqual(["save-image", "Save image"]);
    expect(menu()).toContainEqual(["save", "Share"]);
    platform.OS = "android";
    platform.Version = 29;
    expect(menu()).toContainEqual(["save-image", "Save image"]);
  });

  it("keeps only Save or share where the save would need a permission or Photos cannot import", () => {
    platform.OS = "android";
    platform.Version = 28;
    expect(menu().map(([id]) => id)).not.toContain("save-image");
    expect(menu()).toContainEqual(["save", "Save or share"]);
    platform.OS = "ios";
    for (const mimeType of ["image/svg+xml", "image/*", "video/mp4", "application/pdf"]) {
      expect(menu(mimeType).map(([id]) => id)).not.toContain("save-image");
      expect(menu(mimeType)).toContainEqual(["save", "Save or share"]);
    }
  });

  it("reads the base type, so a parameter does not hide the item", () => {
    expect(canSaveImageToLibrary("image/JPEG; charset=binary", { OS: "ios", Version: "18.0" })).toBe(true);
    expect(canSaveImageToLibrary("image/heic", { OS: "web", Version: "" })).toBe(false);
  });
});

describe("Save image", () => {
  function runSave() {
    useMediaActions(imageSource())
      .actions.find(({ id }) => id === "save-image")!
      .run();
  }

  it("downloads the original, saves that file, then removes the cached copy", async () => {
    runSave();
    await settle();
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toMatch(/^https:\/\/host\.test\/signed\/shot\.png -> file:\/\/\/cache\/solus-attachment-downloads\/\d+-0{8}-0{4}-4000-8000-0{12}\/shot\.png$/);
    const file = downloads[0]!.split(" -> ")[1]!;
    expect(saves).toEqual([[file, "image/png", "shot.png"]]);
    expect(removed).toEqual([file.slice(0, file.lastIndexOf("/"))]);
    expect(alerts).toEqual([]);
  });

  it("removes the cached copy and says why when Photos refuses", async () => {
    saveError = new Error("Allow Solus to add photos in Settings.");
    runSave();
    await settle();
    expect(removed).toHaveLength(1);
    expect(alerts).toEqual([["Could not save image", "Allow Solus to add photos in Settings."]]);
  });

  it("removes the empty folder and asks for a connection when the download fails", async () => {
    failDownload = true;
    runSave();
    await settle();
    expect(saves).toEqual([]);
    expect(removed).toHaveLength(1);
    expect(alerts).toEqual([
      ["Could not save image", "Could not download the image. Check the connection and try again."],
    ]);
  });
});
