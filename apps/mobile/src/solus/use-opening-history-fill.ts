import { useEffect, useMemo, useRef, useState } from "react";

/** Let the native list draw a frame between older pages and finish a gesture before inserting one. */
export function useOpeningHistoryFill(
  fill: ((beforeInsert: () => Promise<void>) => Promise<void>) | undefined,
  cursor: string | null | undefined,
  hasOpeningPage: boolean,
  threadKey: string,
  canScrollBack: () => boolean,
) {
  const [draggedThread, setDraggedThread] = useState<string | null>(null);
  const scrolling = useRef(false);
  const resumeInsert = useRef<(() => void) | null>(null);
  const releaseFrame = useRef<number | null>(null);
  const hasEarlierPage = !!cursor;
  const gestures = useMemo(() => {
    const begin = () => {
      if (!hasEarlierPage && !scrolling.current) return;
      if (releaseFrame.current !== null) cancelAnimationFrame(releaseFrame.current);
      releaseFrame.current = null;
      scrolling.current = true;
      setDraggedThread(threadKey);
    };
    const end = () => {
      if (!scrolling.current || releaseFrame.current !== null) return;
      // A drag can turn into momentum before the next frame.
      releaseFrame.current = requestAnimationFrame(() => {
        releaseFrame.current = null;
        scrolling.current = false;
        resumeInsert.current?.();
        resumeInsert.current = null;
      });
    };
    return { onScrollBeginDrag: begin, onScrollEndDrag: end, onMomentumScrollBegin: begin, onMomentumScrollEnd: end };
  }, [hasEarlierPage, threadKey]);
  useEffect(() => () => {
    if (releaseFrame.current !== null) cancelAnimationFrame(releaseFrame.current);
    releaseFrame.current = null;
    scrolling.current = false;
    resumeInsert.current?.();
    resumeInsert.current = null;
  }, [threadKey]);
  useEffect(() => {
    if (!fill) return;
    // A prepend can move measured rows during the opening frame. A reader with
    // a full viewport already has history to scroll through on the first drag.
    if (!hasOpeningPage && draggedThread !== threadKey && canScrollBack()) return;
    const insert = () => void fill(async () => {
      if (scrolling.current) await new Promise<void>(resolve => { resumeInsert.current = resolve });
    });
    // A short saved page can fit entirely on screen. Make its first older page scrollable as soon as the list lands.
    if (hasOpeningPage) {
      insert();
      return;
    }
    let idle: number | undefined;
    const frame = requestAnimationFrame(() => {
      idle = requestIdleCallback(insert, { timeout: 2000 });
    });
    return () => {
      cancelAnimationFrame(frame);
      if (idle !== undefined) cancelIdleCallback(idle);
    };
  }, [fill, cursor, hasOpeningPage, threadKey, draggedThread, canScrollBack]);
  return gestures;
}
