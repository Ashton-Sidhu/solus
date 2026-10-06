// Adapted from T3 Code apps/mobile/src/lib/videoThumbnails.test.ts (MIT, see apps/mobile/UPSTREAM.md).
// Bun cannot reset a module between tests, so each test uses its own cache keys.
import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test";

const frame = { width: 480, height: 270 };
const player = () => ({
  bufferOptions: {},
  replaceAsync: mock(async (): Promise<void> => {}),
  generateThumbnailsAsync: mock(async (): Promise<(typeof frame)[]> => [frame]),
  release: mock(() => {}),
});
const createPlayer = mock(player);
mock.module("expo-video", () => ({ createVideoPlayer: () => createPlayer() }));

const thumbnails = await import("../../apps/mobile/src/lib/videoThumbnails");
const source = () => ({ uri: "file:///clip.mp4", dispose: mock(() => {}) });

beforeEach(() => {
  createPlayer.mockReset();
  createPlayer.mockImplementation(player);
});

afterEach(() => jest.useRealTimers());

describe("video thumbnails", () => {
  it("reuses a frame for duplicate requests and refreshed signed URLs", async () => {
    // WHY: a feed re-renders rows often and signed URLs renew; each must not
    // decode the video again.
    const file = source();
    const resolveSource = mock(async () => file);
    const signal = new AbortController().signal;
    const results = await Promise.all([
      thumbnails.loadVideoThumbnail("reuse:clip", resolveSource, signal),
      thumbnails.loadVideoThumbnail("reuse:clip", resolveSource, signal),
    ]);
    expect(results).toEqual([frame, frame]);
    expect(resolveSource).toHaveBeenCalledTimes(1);
    expect(createPlayer).toHaveBeenCalledTimes(1);
    expect(file.dispose).toHaveBeenCalledTimes(1);
    const refreshed = mock(async () => ({ ...source(), uri: "https://host/new-token/clip.mp4" }));
    expect(await thumbnails.loadVideoThumbnail("reuse:clip", refreshed, signal)).toBe(frame);
    expect(refreshed).not.toHaveBeenCalled();
  });

  it("serializes decoding and skips queued requests that scroll out of view", async () => {
    const started = Promise.withResolvers<void>();
    const generated = Promise.withResolvers<(typeof frame)[]>();
    const first = player();
    first.generateThumbnailsAsync.mockImplementation(() => {
      started.resolve();
      return generated.promise;
    });
    createPlayer.mockReturnValueOnce(first);
    const firstRequest = thumbnails.loadVideoThumbnail(
      "serial:first",
      async () => source(),
      new AbortController().signal,
    );
    await started.promise;
    const removed = new AbortController();
    const skipped = mock(async () => source());
    const queued = thumbnails.loadVideoThumbnail("serial:removed", skipped, removed.signal);
    const next = mock(async () => source());
    const nextRequest = thumbnails.loadVideoThumbnail(
      "serial:next",
      next,
      new AbortController().signal,
    );
    expect(next).not.toHaveBeenCalled();
    removed.abort();
    generated.resolve([frame]);
    expect(await firstRequest).toBe(frame);
    expect(await queued).toBeNull();
    expect(await nextRequest).toBe(frame);
    expect(skipped).not.toHaveBeenCalled();
    expect(first.release).toHaveBeenCalledTimes(1);
  });

  it("releases an active canceled player and ignores late source loading", async () => {
    const started = Promise.withResolvers<void>();
    const replaced = Promise.withResolvers<void>();
    const first = player();
    first.replaceAsync.mockImplementation(() => {
      started.resolve();
      return replaced.promise;
    });
    createPlayer.mockReturnValueOnce(first);
    const file = source();
    const controller = new AbortController();
    const request = thumbnails.loadVideoThumbnail(
      "cancel:canceled",
      async () => file,
      controller.signal,
    );
    await started.promise;
    controller.abort();
    expect(await request).toBeNull();
    expect(first.release).toHaveBeenCalledTimes(1);
    expect(file.dispose).toHaveBeenCalledTimes(1);
    replaced.resolve();
    expect(
      await thumbnails.loadVideoThumbnail(
        "cancel:next",
        async () => source(),
        new AbortController().signal,
      ),
    ).toBe(frame);
    expect(first.generateThumbnailsAsync).not.toHaveBeenCalled();
    expect(thumbnails.cachedVideoThumbnail("cancel:canceled")).toBeNull();
  });

  it("releases failed extractions and permits a later retry", async () => {
    const broken = player();
    broken.generateThumbnailsAsync.mockRejectedValue(new Error("Invalid video"));
    createPlayer.mockReturnValueOnce(broken);
    const file = source();
    expect(
      await thumbnails.loadVideoThumbnail("retry", async () => file, new AbortController().signal),
    ).toBeNull();
    expect(broken.release).toHaveBeenCalledTimes(1);
    expect(file.dispose).toHaveBeenCalledTimes(1);
    expect(
      await thumbnails.loadVideoThumbnail(
        "retry",
        async () => source(),
        new AbortController().signal,
      ),
    ).toBe(frame);
  });

  it("does not let an unreachable source block the queue indefinitely", async () => {
    jest.useFakeTimers();
    const started = Promise.withResolvers<void>();
    const first = player();
    first.replaceAsync.mockImplementation(() => {
      started.resolve();
      return new Promise(() => {});
    });
    createPlayer.mockReturnValueOnce(first);
    const file = source();
    const request = thumbnails.loadVideoThumbnail(
      "unreachable",
      async () => file,
      new AbortController().signal,
    );
    await started.promise;
    jest.advanceTimersByTime(15_000);
    expect(await request).toBeNull();
    expect(first.release).toHaveBeenCalledTimes(1);
    expect(file.dispose).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
    expect(
      await thumbnails.loadVideoThumbnail(
        "reachable",
        async () => source(),
        new AbortController().signal,
      ),
    ).toBe(frame);
  });

  it("bounds the retained native images without invalidating frames still displayed", async () => {
    for (let i = 0; i < 33; i++) {
      await thumbnails.loadVideoThumbnail(
        `bound:${i}`,
        async () => source(),
        new AbortController().signal,
      );
    }
    expect(thumbnails.cachedVideoThumbnail("bound:0")).toBeNull();
    expect(thumbnails.cachedVideoThumbnail("bound:32")).toBe(frame);
    expect(createPlayer).toHaveBeenCalledTimes(33);
    expect(
      await thumbnails.loadVideoThumbnail(
        "bound:0",
        async () => source(),
        new AbortController().signal,
      ),
    ).toBe(frame);
    expect(createPlayer).toHaveBeenCalledTimes(34);
  });
});
