import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";

export class CopyTextClipboardWriteError extends Error {
  readonly _tag = "CopyTextClipboardWriteError";
  constructor(readonly props: { readonly target: string; readonly cause: unknown }) {
    super(`Failed to copy ${props.target} to the clipboard.`, { cause: props.cause });
  }
}

export class CopyTextHapticFeedbackError extends Error {
  readonly _tag = "CopyTextHapticFeedbackError";
  constructor(
    readonly props: {
      readonly target: string;
      readonly feedback: "light-impact" | "selection";
      readonly cause: unknown;
    },
  ) {
    super(
      `Failed to trigger ${props.feedback} haptic feedback after copying ${props.target}.`,
      { cause: props.cause },
    );
  }
}

interface CopyTextWithHapticOptions {
  readonly target?: string;
  readonly feedback?: "light-impact" | "selection";
}

export async function tryCopyTextWithHaptic(
  value: string,
  options: CopyTextWithHapticOptions = {},
): Promise<boolean> {
  const target = options.target ?? "text";
  const feedback = options.feedback ?? "light-impact";

  const clipboardWrite = (async () => {
    try {
      await Clipboard.setStringAsync(value);
      return true;
    } catch (cause) {
      const error = new CopyTextClipboardWriteError({ target, cause });
      console.error(error.message, { _tag: error._tag, target, stack: error.stack });
      return false;
    }
  })();

  void (async () => {
    try {
      if (feedback === "selection") {
        await Haptics.selectionAsync();
      } else {
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
    } catch (cause) {
      const error = new CopyTextHapticFeedbackError({ target, feedback, cause });
      console.error(error.message, { _tag: error._tag, target, feedback, stack: error.stack });
    }
  })();

  return await clipboardWrite;
}

export function copyTextWithHaptic(value: string, options: CopyTextWithHapticOptions = {}): void {
  void tryCopyTextWithHaptic(value, options);
}
