// Adapted from T3 Code apps/mobile/src/components/ComposerAttachmentButton.tsx (MIT, see UPSTREAM.md).
import type { MenuAction } from "@react-native-menu/menu";
import { Pressable } from "react-native";

import { useAndroidControlSizing } from "./useAndroidControlSizing";
import { SymbolView } from "./AppSymbol";
import { ControlPillMenu } from "./ControlPill";

const ATTACHMENT_MENU_ACTIONS: MenuAction[] = [
  { id: "photos", title: "Photo Library", image: "photo" },
  { id: "files", title: "Choose Files", image: "folder" },
];
const REFERENCE_SESSION_ACTION: MenuAction = { id: "session", title: "Reference Session…", image: "text.bubble" };

export function ComposerAttachmentButton(props: {
  readonly disabled?: boolean;
  readonly supportsFiles: boolean;
  readonly onPickMedia: () => Promise<void>;
  readonly onPickFiles: () => Promise<void>;
  /** Full attachments still allow a session reference. */
  readonly attachmentsFull?: boolean;
  /** Offers "Reference Session…": a session reference is text, not a file. */
  readonly onReferenceSession?: () => void;
}) {
  const { scale } = useAndroidControlSizing();
  const button = (
    <Pressable
      accessibilityLabel="Add attachment"
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      className="size-[44px] shrink-0 items-center justify-center rounded-full active:opacity-70 disabled:opacity-50"
      disabled={props.disabled}
      onPress={props.supportsFiles ? undefined : () => void props.onPickMedia()}
    >
      <SymbolView
        name="plus"
        size={Math.round(20 * scale)}
        weight="regular"
        tintColorClassName="accent-icon"
        type="monochrome"
      />
    </Pressable>
  );

  const attachActions = props.attachmentsFull ? [] : props.supportsFiles ? ATTACHMENT_MENU_ACTIONS : ATTACHMENT_MENU_ACTIONS.slice(0, 1);
  const actions = props.onReferenceSession ? [...attachActions, REFERENCE_SESSION_ACTION] : attachActions;
  if (props.disabled || actions.length === 0 || (!props.supportsFiles && !props.onReferenceSession)) {
    return button;
  }

  return (
    <ControlPillMenu
      accessible
      accessibilityLabel="Add attachment"
      accessibilityRole="button"
      actions={actions}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "photos") {
          void props.onPickMedia();
        } else if (nativeEvent.event === "files") {
          void props.onPickFiles();
        } else if (nativeEvent.event === "session") {
          props.onReferenceSession?.();
        }
      }}
    >
      {button}
    </ControlPillMenu>
  );
}
