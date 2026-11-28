import { describe, expect, it, vi } from "vite-plus/test";
import { pullRequestTabOffset, scrollToPullRequestFiles } from "./pullRequestTabScroll";

describe("pull request tab scroll", () => {
  it("keeps the header fixed while switching, even if the destination was scrolled deeply", () => {
    expect(pullRequestTabOffset(-100, 900, 200)).toBe(-100);
    expect(pullRequestTabOffset(75, 900, 200)).toBe(75);
  });
  it("resumes the destination body only when the shared header is already collapsed", () => {
    expect(pullRequestTabOffset(600, 900, 200)).toBe(900);
    expect(pullRequestTabOffset(600, 50, 200)).toBe(200);
    expect(pullRequestTabOffset(600, undefined, 200)).toBe(200);
  });
  it("retains the saved body offset when native scrolling rounds the collapsed header", () => {
    const headerEnd = 213.6666717529297 - 116;
    expect(pullRequestTabOffset(97.66666666666667, 800, headerEnd)).toBe(800);
    expect(pullRequestTabOffset(headerEnd - 1, 800, headerEnd)).toBe(headerEnd - 1);
  });
  it("waits for the files section and scrolls it below the app bar", () => {
    const scrollToKey = vi.fn(async () => {});
    const overview = { scrollToKey };
    expect(scrollToPullRequestFiles(null, 400, 60)).toBe(false);
    expect(scrollToPullRequestFiles(overview, null, 60)).toBe(false);
    expect(scrollToKey).not.toHaveBeenCalled();
    expect(scrollToPullRequestFiles(overview, 400, 60)).toBe(true);
    expect(scrollToKey).toHaveBeenCalledWith({
      key: "overview:body",
      viewPosition: 0,
      viewOffset: -340,
      animated: true,
    });
  });
});
