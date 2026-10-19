// PR Share uses each platform's share contract, and a cancelled sheet is not
// an error. The iOS segmented control is UIKit's: it moves its selection on a
// tap before the caller decides, so a refused choice must snap it back.
import { describe, expect, it } from "bun:test";
import type { ShareContent, ShareOptions } from "react-native";

import { linkShareContent, shareLink, type ShareSheet } from "../../apps/mobile/src/lib/share-link";
import { settleNativeSegment } from "../../apps/mobile/src/lib/native-segment-sync";

const link = { url: "https://github.com/acme/app/pull/7", title: "#7 Fix login" };

function sheet(answer: () => Promise<{ readonly action: string }>) {
  const calls: { content: ShareContent; options?: ShareOptions }[] = [];
  const share: ShareSheet = {
    share(content, options) {
      calls.push({ content, options });
      return answer();
    },
  };
  return { share, calls };
}

describe("PR link share", () => {
  it("sends the URL on iOS and the URL as the message on Android", () => {
    expect(linkShareContent(link, "ios")).toEqual({ url: link.url });
    expect(linkShareContent(link, "android")).toEqual({ message: link.url, title: link.title });
  });

  it("reads a dismissed iOS sheet as a cancel, not a failure", async () => {
    const { share } = sheet(async () => ({ action: "dismissedAction" }));
    expect(await shareLink(share, link, "ios")).toEqual({ kind: "dismissed" });
  });

  it("titles the Android chooser and reads an opened chooser as shared", async () => {
    const { share, calls } = sheet(async () => ({ action: "sharedAction" }));
    expect(await shareLink(share, link, "android")).toEqual({ kind: "shared" });
    expect(calls[0]?.options).toEqual({ dialogTitle: link.title });
  });

  it("reports a share that could not open", async () => {
    const { share } = sheet(async () => {
      throw new Error("No activity found");
    });
    expect(await shareLink(share, link, "android")).toEqual({ kind: "failed", message: "No activity found" });
  });
});

describe("native segmented control selection", () => {
  it("keeps an accepted choice and remounts on a refused one", () => {
    const resting = { chosen: null, revision: 3 };
    expect(settleNativeSegment(resting, "overview")).toBe(resting);
    expect(settleNativeSegment({ chosen: { value: "activity" }, revision: 3 }, "activity")).toEqual({ chosen: null, revision: 3 });
    expect(settleNativeSegment({ chosen: { value: "approve" }, revision: 3 }, "comment")).toEqual({ chosen: null, revision: 4 });
  });
});
