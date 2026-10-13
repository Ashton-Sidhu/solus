// Adapted from T3 Code apps/mobile/src/features/threads/thread-feed-live-follow.ts (MIT, see UPSTREAM.md).
export type ThreadFeedLiveFollowEvent =
  | { readonly type: "reset" }
  | { readonly type: "user-scroll-begin" }
  | {
      readonly type: "user-scroll-end";
      readonly isAtEnd: boolean;
      readonly userScrollSessionActive: boolean;
    }
  | {
      readonly type: "scroll" | "disclosure-settled";
      readonly isAtEnd: boolean;
      readonly userScrollSessionActive: boolean;
    };

export function resolveThreadFeedLiveFollow(
  current: boolean,
  event: ThreadFeedLiveFollowEvent,
): boolean {
  switch (event.type) {
    case "reset":
      return true;
    case "user-scroll-begin":
      return false;
    case "user-scroll-end":
      return event.userScrollSessionActive ? event.isAtEnd : current;
    case "disclosure-settled":
      return !event.userScrollSessionActive && event.isAtEnd;
    case "scroll":
      if (event.userScrollSessionActive) {
        return false;
      }
      if (event.isAtEnd) {
        return true;
      }
      return current;
  }
}
