// Adapted from T3 Code apps/mobile/src/features/diffs/nativeReviewDiffSurface.ts (MIT, see UPSTREAM.md).
import {
  createElement,
  useEffect,
  useImperativeHandle,
  useRef,
  type ComponentType,
  type Ref,
} from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";
import { requireNativeView } from "expo";
import { z } from "zod";

import { NativeViewResolutionError } from "../../native/nativeViewResolutionError";

const NATIVE_REVIEW_DIFF_MODULE_NAME = "T3ReviewDiffSurface";
const NATIVE_REVIEW_DIFF_PAYLOAD_RETRY_FRAMES = 60;

export interface NativeReviewDiffRow {
  readonly kind: "file" | "hunk" | "line" | "notice" | "comment";
  readonly id: string;
  readonly fileId?: string;
  readonly filePath?: string;
  readonly previousPath?: string | null;
  readonly changeType?:
    | "modified"
    | "new"
    | "deleted"
    | "renamed"
    | "rename-pure"
    | "rename-changed";
  readonly additions?: number;
  readonly deletions?: number;
  readonly text?: string;
  readonly content?: string;
  readonly change?: "context" | "add" | "delete";
  readonly oldLineNumber?: number | null;
  readonly newLineNumber?: number | null;
  readonly wordDiffRanges?: ReadonlyArray<NativeReviewDiffWordDiffRange>;
  readonly commentText?: string;
  readonly commentRangeLabel?: string;
  readonly commentSectionTitle?: string;
}

export interface NativeReviewDiffWordDiffRange {
  readonly start: number;
  readonly end: number;
}

export interface NativeReviewDiffToken {
  readonly content: string;
  readonly color: string | null;
  readonly fontStyle: number | null;
}

export interface NativeReviewDiffTheme {
  readonly background: string;
  readonly text: string;
  readonly mutedText: string;
  readonly headerBackground: string;
  readonly border: string;
  readonly hunkBackground: string;
  readonly hunkText: string;
  readonly addBackground: string;
  readonly deleteBackground: string;
  readonly addBar: string;
  readonly deleteBar: string;
  readonly addText: string;
  readonly deleteText: string;
}

export interface NativeReviewDiffStyle {
  readonly rowHeight?: number;
  readonly contentWidth?: number;
  readonly changeBarWidth?: number;
  readonly gutterWidth?: number;
  readonly codePadding?: number;
  readonly textVerticalInset?: number;
  readonly fileHeaderHeight?: number;
  readonly fileHeaderHorizontalMargin?: number;
  readonly fileHeaderVerticalMargin?: number;
  readonly fileHeaderCornerRadius?: number;
  readonly fileHeaderHorizontalPadding?: number;
  readonly fileHeaderPathRightPadding?: number;
  readonly fileHeaderCountColumnWidth?: number;
  readonly fileHeaderCountGap?: number;
  readonly codeFontSize?: number;
  readonly codeFontWeight?: string;
  readonly lineNumberFontSize?: number;
  readonly lineNumberFontWeight?: string;
  readonly hunkFontSize?: number;
  readonly hunkFontWeight?: string;
  readonly fileHeaderFontSize?: number;
  readonly fileHeaderFontWeight?: string;
  readonly fileHeaderMetaFontSize?: number;
  readonly fileHeaderMetaFontWeight?: string;
  readonly fileHeaderSubtextFontSize?: number;
  readonly fileHeaderSubtextFontWeight?: string;
  readonly fileHeaderStatusFontSize?: number;
  readonly fileHeaderStatusFontWeight?: string;
  readonly emptyStateFontSize?: number;
  readonly emptyStateFontWeight?: string;
}

/**
 * The `onDebug` event of the native view. `message` names the event; the other
 * fields are present only for the messages that send them:
 * `visible-range` and `draw-metrics` send the row range, `rows-decoded` sends
 * `rows`, and `metrics` sends `contentHeight` (in points).
 */
export interface NativeReviewDiffDebugPayload {
  readonly message?: string;
  readonly reason?: string;
  readonly firstRowIndex?: number;
  readonly lastRowIndex?: number;
  readonly totalRows?: number;
  readonly rows?: number;
  readonly contentHeight?: number;
  readonly error?: string;
}

export interface NativeReviewDiffViewProps extends ViewProps {
  readonly contentInsetTop?: number;
  readonly contentInsetBottom?: number;
  readonly rowsJson: string;
  readonly tokensJson?: string;
  readonly tokensPatchJson?: string;
  readonly tokensResetKey?: string;
  readonly contentResetKey?: string;
  readonly collapsedFileIdsJson?: string;
  readonly viewedFileIdsJson?: string;
  readonly selectedRowIdsJson?: string;
  readonly collapsedCommentIdsJson?: string;
  readonly appearanceScheme: "light" | "dark";
  readonly themeJson: string;
  readonly styleJson?: string;
  readonly rowHeight: number;
  readonly contentWidth: number;
  readonly initialRowIndex?: number;
  /** Disable the native vertical scroller when an excerpt grows inside a page. */
  readonly scrollEnabled?: boolean;
  readonly bounces?: boolean;
  readonly refreshing?: boolean;
  readonly nativeViewRef?: Ref<NativeReviewDiffViewHandle>;
  readonly onPullToRefresh?: (event: NativeSyntheticEvent<Record<string, never>>) => void;
  readonly onDebug?: (event: NativeSyntheticEvent<NativeReviewDiffDebugPayload>) => void;
  readonly onVisibleFileChange?: (
    event: NativeSyntheticEvent<{ readonly fileId?: string | null }>,
  ) => void;
  readonly onToggleFile?: (event: NativeSyntheticEvent<{ readonly fileId?: string }>) => void;
  readonly onToggleViewedFile?: (event: NativeSyntheticEvent<{ readonly fileId?: string }>) => void;
  readonly onPressLine?: (
    event: NativeSyntheticEvent<{
      readonly rowId?: string;
      readonly fileId?: string;
      readonly gesture?: "tap" | "longPress";
      readonly oldLineNumber?: number;
      readonly newLineNumber?: number;
      readonly change?: "context" | "add" | "delete";
    }>,
  ) => void;
  readonly onToggleComment?: (event: NativeSyntheticEvent<{ readonly commentId?: string }>) => void;
}

export interface NativeReviewDiffViewHandle {
  readonly scrollToFile: (fileId: string, animated?: boolean) => Promise<void>;
  readonly scrollToTop: (animated?: boolean) => Promise<void>;
}

/**
 * The fields of the `onDebug` event that the clients read. A field that is
 * missing or has a different type becomes `undefined`.
 */
const NativeReviewDiffDebugEventSchema = z.object({
  message: z.string().optional().catch(undefined),
  firstRowIndex: z.number().optional().catch(undefined),
  lastRowIndex: z.number().optional().catch(undefined),
  totalRows: z.number().optional().catch(undefined),
  contentHeight: z.number().optional().catch(undefined),
});

export type NativeReviewDiffDebugEvent = z.infer<typeof NativeReviewDiffDebugEventSchema>;

/** Parse the payload of the `onDebug` event at the native boundary. */
export function parseNativeReviewDiffDebugEvent(
  payload: NativeReviewDiffDebugPayload,
): NativeReviewDiffDebugEvent {
  return NativeReviewDiffDebugEventSchema.parse(payload);
}

export function isNativeReviewDiffDrawEvent(payload: NativeReviewDiffDebugEvent): boolean {
  return payload.message === "draw-metrics" || payload.message === "visible-range";
}

interface NativeReviewDiffViewRef {
  readonly setRowsJson: (rowsJson: string) => Promise<void>;
  readonly setTokensJson: (tokensJson: string) => Promise<void>;
  readonly setTokensPatchJson: (tokensPatchJson: string) => Promise<void>;
  readonly scrollToFile: (fileId: string, animated: boolean) => Promise<void>;
  readonly scrollToTop: (animated: boolean) => Promise<void>;
}

type NativeReviewDiffRawViewProps = Omit<
  NativeReviewDiffViewProps,
  "nativeViewRef" | "rowsJson" | "tokensJson" | "tokensPatchJson"
> & {
  readonly refreshEnabled: boolean;
  readonly ref?: Ref<NativeReviewDiffViewRef>;
};

let cachedNativeReviewDiffRawView: ComponentType<NativeReviewDiffRawViewProps> | undefined;
let nativeReviewDiffViewResolutionFailed = false;

type NativeReviewDiffPayloadMethod = "setRowsJson" | "setTokensJson" | "setTokensPatchJson";

export function isPendingNativeViewRegistration(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  return (
    cause.message.includes(`Unable to find the '${NATIVE_REVIEW_DIFF_MODULE_NAME}' view`) ||
    (cause.message.includes("Unable to find the class") &&
      cause.message.includes("T3ReviewDiffView view with tag"))
  );
}

function useNativeReviewDiffPayload(
  nativeRef: React.RefObject<NativeReviewDiffViewRef | null>,
  method: NativeReviewDiffPayloadMethod,
  payload: string | undefined,
) {
  useEffect(() => {
    if (payload === undefined) {
      return;
    }

    let cancelled = false;
    let frame: number | null = null;
    let attempts = 0;

    const dispatch = () => {
      if (cancelled) {
        return;
      }

      const view = nativeRef.current;
      const command = view?.[method];
      if (!view || !command) {
        if (attempts < NATIVE_REVIEW_DIFF_PAYLOAD_RETRY_FRAMES) {
          attempts += 1;
          frame = requestAnimationFrame(dispatch);
        }
        return;
      }

      void command.call(view, payload).catch((cause: unknown) => {
        if (
          !cancelled &&
          attempts < NATIVE_REVIEW_DIFF_PAYLOAD_RETRY_FRAMES &&
          isPendingNativeViewRegistration(cause)
        ) {
          attempts += 1;
          frame = requestAnimationFrame(dispatch);
          return;
        }
        console.error(`[native-review-diff] ${method} failed`, cause);
      });
    };

    // Fabric attaches the React ref before Expo registers the native tag used by
    // view functions. Starting on the next frame avoids racing that registration.
    frame = requestAnimationFrame(dispatch);

    return () => {
      cancelled = true;
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
    };
  }, [method, nativeRef, payload]);
}

function getExpoViewConfig(moduleName: string) {
  // The `expo` global is not present outside the native runtime, for example in tests.
  return globalThis.expo?.getViewConfig?.(moduleName);
}

function NativeReviewDiffView(props: NativeReviewDiffViewProps) {
  const { nativeViewRef, rowsJson, tokensJson, tokensPatchJson, ...nativeProps } = props;
  const nativeRef = useRef<NativeReviewDiffViewRef>(null);
  useNativeReviewDiffPayload(nativeRef, "setRowsJson", rowsJson);
  useNativeReviewDiffPayload(nativeRef, "setTokensJson", tokensJson);
  useNativeReviewDiffPayload(nativeRef, "setTokensPatchJson", tokensPatchJson);
  useImperativeHandle(
    nativeViewRef,
    () => ({
      scrollToFile: async (fileId, animated = true) => {
        await nativeRef.current?.scrollToFile(fileId, animated);
      },
      scrollToTop: async (animated = true) => {
        await nativeRef.current?.scrollToTop(animated);
      },
    }),
    [],
  );

  const RawNativeView = cachedNativeReviewDiffRawView;
  if (!RawNativeView) {
    return null;
  }

  return createElement(RawNativeView, {
    ...nativeProps,
    refreshEnabled: props.onPullToRefresh !== undefined,
    ref: nativeRef,
  });
}

export function resolveNativeReviewDiffView(): ComponentType<NativeReviewDiffViewProps> | null {
  if (cachedNativeReviewDiffRawView) {
    return NativeReviewDiffView;
  }

  if (nativeReviewDiffViewResolutionFailed) {
    return null;
  }

  if (getExpoViewConfig(NATIVE_REVIEW_DIFF_MODULE_NAME) == null) {
    return null;
  }

  try {
    cachedNativeReviewDiffRawView = requireNativeView<NativeReviewDiffRawViewProps>(
      NATIVE_REVIEW_DIFF_MODULE_NAME,
    );
  } catch (cause) {
    nativeReviewDiffViewResolutionFailed = true;
    console.error(
      new NativeViewResolutionError({
        nativeModuleName: NATIVE_REVIEW_DIFF_MODULE_NAME,
        cause,
      }),
    );
    return null;
  }

  return cachedNativeReviewDiffRawView ? NativeReviewDiffView : null;
}
