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
const MCP_PROMPT_ACTION: MenuAction = { id: "mcp-prompt", title: "MCP Prompt…", image: "text.badge.plus" };
const MCP_RESOURCE_ACTION: MenuAction = { id: "resource", title: "MCP Resource…", image: "server.rack" };

export function ComposerAttachmentButton(props: {
  readonly disabled?: boolean;
  readonly size?: "regular" | "large";
  readonly supportsFiles: boolean;
  readonly onPickMedia: () => Promise<void>;
  readonly onPickFiles: () => Promise<void>;
  /** Full attachments still allow a session reference. */
  readonly attachmentsFull?: boolean;
  /** Offers "Reference Session…": a session reference is text, not a file. */
  readonly onReferenceSession?: () => void;
  /** Offers "MCP Prompt…": the phone's way to the prompts desktop lists in the `/` menu. */
  readonly onMcpPrompt?: () => void;
  /** Offers "MCP Resource…": the host reads a resource into the attachments. */
  readonly onAttachResource?: () => void;
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
        size={Math.round((props.size === "large" ? 26 : 20) * scale)}
        weight="regular"
        tintColorClassName="accent-icon"
        type="monochrome"
      />
    </Pressable>
  );

  const pickActions = props.supportsFiles ? ATTACHMENT_MENU_ACTIONS : ATTACHMENT_MENU_ACTIONS.slice(0, 1);
  const resourceActions = props.onAttachResource ? [MCP_RESOURCE_ACTION] : [];
  const attachActions = props.attachmentsFull ? [] : [...pickActions, ...resourceActions];
  const actions = [
    ...attachActions,
    ...(props.onReferenceSession ? [REFERENCE_SESSION_ACTION] : []),
    ...(props.onMcpPrompt ? [MCP_PROMPT_ACTION] : []),
  ];
  if (props.disabled || actions.length === 0 || (!props.supportsFiles && !props.onReferenceSession && !props.onMcpPrompt)) {
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
        } else if (nativeEvent.event === "mcp-prompt") {
          props.onMcpPrompt?.();
        } else if (nativeEvent.event === "resource") {
          props.onAttachResource?.();
        }
      }}
    >
      {button}
    </ControlPillMenu>
  );
}
