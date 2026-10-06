// Adapted from T3 Code apps/mobile/src/features/review/reviewHighlightedToken.types.ts (MIT, see UPSTREAM.md).
export interface ReviewHighlightedToken {
  content: string;
  readonly color: string | null;
  readonly fontStyle: number | null;
  readonly diffHighlight?: boolean;
}
