// Adapted from T3 Code apps/mobile/src/features/threads/thread-list-v2-items.tsx (MIT, see UPSTREAM.md).
import {
  THREAD_LIST_V2_MONO_FONT as MONO_FONT,
  THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME,
  THREAD_LIST_V2_ROW_DIVIDERS,
  selectedThreadRowColors,
  getThreadListV2RowAppearance,
} from "./thread-list-v2-row-appearance";
import { RowPressable } from "../../components/RowPressable";
import type { MenuAction } from "@react-native-menu/menu";
import { memo, useCallback, useMemo, type ComponentProps } from "react";
import { Alert, Pressable, useWindowDimensions, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { ProviderInstanceIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useSwipeRowDormant } from "../home/swipe-row-activation";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import type { SolusThreadShell } from "./thread-directory";
import { resolveSnoozePresets, resolveThreadListV2SnoozeMenuSelection } from "./thread-snooze";
import {
  THREAD_LIST_V2_SETTLED_PAGE_COUNT,
  resolveThreadListV2SwipeActions,
  threadTitle,
  type ThreadListV2Status,
  type ThreadPrPresentation,
  type ThreadPrWatchTarget,
} from "./threadListV2";

/**
 * Thread List v2 renders one flat native list: rich edge-to-edge rows for
 * active work and a receded settled tail, all with native swipe and
 * long-press actions. State reads through colored status labels and text
 * hierarchy rather than card fills.
 */

// Status hues follow the system-wide convention (amber approval, indigo
// input, sky working) so a thread reads the same color everywhere it surfaces.
const STATUS_LABEL_BY_STATUS: Partial<
  Record<ThreadListV2Status, { label: string; className: string }>
> = {
  approval: { label: "Approval", className: "text-warning-foreground" },
  input: { label: "Input", className: "text-adaptive-indigo-600-300" },
  working: { label: "Working", className: "text-adaptive-sky-600-400" },
  failed: { label: "Failed", className: "text-danger-foreground" },
  limited: { label: "Limited", className: "text-warning-foreground" },
};

const PROVIDER_DISPLAY_NAME: Record<SolusThreadShell["record"]["provider"], string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

function ThreadListV2Section(props: {
  readonly label: string;
  readonly pane?: "screen" | "sidebar";
  readonly tone?: "default" | "snoozed";
  readonly disclosure?: {
    readonly expanded: boolean;
    readonly disabled?: boolean;
    readonly onToggle: () => void;
    readonly accessibilityLabel: string;
    readonly accessibilityHint: string;
  };
}) {
  const snoozed = props.tone === "snoozed";
  const sidebarPane = props.pane === "sidebar";
  const className = cn(
    "mb-1.5 mt-4 flex-row items-center gap-2.5",
    props.pane === "sidebar" ? "px-3" : "px-5",
  );
  const content = (
    <>
      <Text
        className={cn(
          "text-xs font-t3-medium",
          sidebarPane
            ? "text-drawer-foreground-muted"
            : snoozed
              ? "text-foreground-secondary"
              : "text-foreground-tertiary",
        )}
      >
        {props.label}
      </Text>
      <View
        className={cn(
          "h-px flex-1",
          snoozed ? "bg-primary/20" : sidebarPane ? "bg-drawer-border" : "bg-border",
        )}
      />
      {props.disclosure ? (
        <SymbolView
          name="chevron.down"
          size={10}
          tintColorClassName={
            sidebarPane
              ? "accent-drawer-foreground-muted"
              : snoozed
                ? "accent-icon-muted"
                : "accent-foreground-muted"
          }
          type="monochrome"
          style={{ transform: [{ rotate: props.disclosure.expanded ? "180deg" : "0deg" }] }}
        />
      ) : null}
    </>
  );

  return props.disclosure ? (
    <Pressable
      accessibilityHint={props.disclosure.accessibilityHint}
      accessibilityLabel={props.disclosure.accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{
        disabled: props.disclosure.disabled,
        expanded: props.disclosure.expanded,
      }}
      className={className}
      disabled={props.disclosure.disabled}
      onPress={props.disclosure.onToggle}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      {content}
    </Pressable>
  ) : (
    <View className={className}>{content}</View>
  );
}

type ThreadListV2ShelfHeaderProps = {
  readonly count: number;
  readonly disabled?: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly pane?: "screen" | "sidebar";
};

function ThreadListV2ShelfHeader(
  props: ThreadListV2ShelfHeaderProps & { readonly kind: "snoozed" | "settled" },
) {
  const label = props.kind === "snoozed" ? "Snoozed" : "Settled";
  return (
    <ThreadListV2Section
      label={props.expanded ? label : `${label} (${props.count})`}
      pane={props.pane}
      tone={props.kind === "snoozed" ? "snoozed" : "default"}
      disclosure={{
        expanded: props.expanded,
        disabled: props.disabled,
        onToggle: props.onToggle,
        accessibilityLabel: `${props.count} ${props.kind} ${props.count === 1 ? "thread" : "threads"}`,
        accessibilityHint: `${props.expanded ? "Collapses" : "Expands"} the ${props.kind} threads.`,
      }}
    />
  );
}

export const ThreadListV2SnoozedShelfHeader = memo(function ThreadListV2SnoozedShelfHeader(
  props: ThreadListV2ShelfHeaderProps,
) {
  return <ThreadListV2ShelfHeader {...props} kind="snoozed" />;
});

export const ThreadListV2SettledShelfHeader = memo(function ThreadListV2SettledShelfHeader(
  props: ThreadListV2ShelfHeaderProps,
) {
  return <ThreadListV2ShelfHeader {...props} kind="settled" />;
});

export const ThreadListV2ShowMoreRow = memo(function ThreadListV2ShowMoreRow(props: {
  readonly pane?: "screen" | "sidebar";
  readonly hiddenCount: number;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Show ${Math.min(props.hiddenCount, THREAD_LIST_V2_SETTLED_PAGE_COUNT)} more settled threads`}
      onPress={props.onPress}
      className="mx-4 mt-2 items-center rounded-lg border border-dashed border-border py-2.5"
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <Text
        className={
          props.pane === "sidebar"
            ? "text-xs font-t3-medium text-drawer-foreground-muted"
            : "text-xs font-t3-medium text-foreground-muted"
        }
      >
        Show more ({props.hiddenCount} settled hidden)
      </Text>
    </Pressable>
  );
});

export const ThreadListV2Row = memo(function ThreadListV2Row(props: {
  readonly thread: SolusThreadShell;
  readonly variant: "card" | "slim";
  /** Snoozed-shelf row: shows its wake time and offers Wake. */
  readonly snoozed?: boolean;
  readonly status: ThreadListV2Status;
  readonly pr: ThreadPrPresentation | null;
  /** Preformatted against the parent minute tick so this memoized row's
      countdown keeps moving. */
  readonly snoozeWakeLabelText?: string;
  /** Preformatted against the parent clock. Blank while a status label or
      the wake countdown owns that slot. */
  readonly timeLabel: string;
  /** Parent minute tick, present only when the row's menu offers snooze
      presets, so those menus refresh while mounted. */
  readonly snoozePresetMinute: string;
  /** The project's path on its host, when the host lists the project. */
  readonly projectPath: string | null;
  readonly projectTitle: string;
  /** Which host holds the thread. Null when only one host is saved —
      repeating the same label on every row is noise. */
  readonly environmentLabel: string | null;
  /** Hosting surface. "screen" (default) renders the compact Home idiom:
      flat edge-to-edge rows on the screen background with inset hairlines.
      "sidebar" renders the iPad split-view idiom: rounded rows blending
      into the drawer surface, selection filled with the accent color. */
  readonly pane?: "screen" | "sidebar";
  /** Keeps row hairlines inside a section; section headers draw their own rule. */
  readonly showTrailingDivider?: boolean;
  /** Highlights the thread open in the detail pane (iPad split view). */
  readonly selected?: boolean;
  /** Override for narrow panes (iPad sidebar); defaults to window width. */
  readonly fullSwipeWidth?: number;
  readonly onSelectThread: (thread: SolusThreadShell) => void;
  readonly onRenameThread: (thread: SolusThreadShell) => void;
  readonly onSettleThread: (thread: SolusThreadShell) => Promise<boolean>;
  readonly onSnoozeThread: (thread: SolusThreadShell, snoozedUntil: number) => void;
  readonly onUnsnoozeThread: (thread: SolusThreadShell) => void;
  readonly onUnsettleThread: (thread: SolusThreadShell) => void;
  readonly onSetPullRequestWatch: (thread: SolusThreadShell, target: ThreadPrWatchTarget, watching: boolean) => void;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  /** List key checked against the Home swipe row activation. */
  readonly activationKey?: string;
  readonly simultaneousSwipeGesture?: ComponentProps<typeof ThreadSwipeable>["simultaneousWith"];
}) {
  const { width: windowWidth } = useWindowDimensions();
  const {
    thread,
    variant,
    status,
    pr,
    onSelectThread,
    onRenameThread,
    onSettleThread,
    onSnoozeThread,
    onUnsnoozeThread,
    onUnsettleThread,
    onSetPullRequestWatch,
  } = props;
  const record = thread.record;
  const title = threadTitle(record);
  const snoozedRow = props.snoozed === true;
  const dormant = useSwipeRowDormant(props.activationKey);

  const theme = useUniwindTheme();
  const sidebarPane = props.pane === "sidebar";
  const selected = props.selected === true;
  const rowAppearance = getThreadListV2RowAppearance(theme, sidebarPane, selected);

  const statusLabel = STATUS_LABEL_BY_STATUS[status];
  // The timestamp is precomputed on the list item so a minute tick only
  // re-renders rows that draw it.
  const timeLabel = props.timeLabel;

  const handleRename = useCallback((): void => onRenameThread(thread), [onRenameThread, thread]);
  const handleSettle = useCallback((): Promise<boolean> => onSettleThread(thread), [onSettleThread, thread]);
  const handleSnooze = useCallback(
    (snoozedUntil: number): void => onSnoozeThread(thread, snoozedUntil),
    [onSnoozeThread, thread],
  );
  const handleUnsnooze = useCallback((): void => onUnsnoozeThread(thread), [onUnsnoozeThread, thread]);
  const handleUnsettle = useCallback((): void => onUnsettleThread(thread), [onUnsettleThread, thread]);

  // Swipe: the v2 primary action is the lifecycle transition. Un-settling a
  // settled row makes it active until the host settles it again.
  const canUnsettle = variant === "slim";
  const swipeActions = resolveThreadListV2SwipeActions({
    variant,
    snoozable: props.snoozePresetMinute !== "",
    snoozed: snoozedRow,
  });
  const snoozePresets = useMemo(
    () => (swipeActions.secondary === "snooze" ? resolveSnoozePresets(new Date()) : ([] as const)),
    [props.snoozePresetMinute, swipeActions.secondary],
  );
  const snoozePresetActions = useMemo<MenuAction[]>(
    () =>
      snoozePresets.map((preset) => ({
        id: `snooze:${preset.id}`,
        title: preset.label,
        subtitle: preset.whenLabel,
      })),
    [snoozePresets],
  );
  const watchTarget = pr?.watchTarget ?? null;
  const titleMenuItems = useMemo<MenuAction[]>(
    () => [
      ...(watchTarget
        ? [watchTarget.isWatched
          ? { id: "stop-watching-pr", title: `Stop Watching #${watchTarget.number}`, image: "eye.slash" }
          : { id: "watch-pr", title: `Watch #${watchTarget.number}`, subtitle: "Wake the agent on checks and reviews", image: "eye" }]
        : []),
      { id: "rename", title: "Rename", image: "square.and.pencil" },
    ],
    [watchTarget],
  );
  const snoozableCardMenuActions = useMemo<MenuAction[]>(
    () => [
      { id: "settle", title: "Settle", image: "checkmark" },
      {
        id: "snooze",
        title: "Snooze",
        image: "clock",
        subactions: snoozePresetActions,
      },
      ...titleMenuItems,
    ],
    [snoozePresetActions, titleMenuItems],
  );
  const cardMenuActions = useMemo<MenuAction[]>(
    () => [{ id: "settle", title: "Settle", image: "checkmark" }, ...titleMenuItems],
    [titleMenuItems],
  );
  const slimMenuActions = useMemo<MenuAction[]>(
    () => [
      { id: "unsettle", title: "Un-settle", image: "arrow.uturn.backward" },
      ...titleMenuItems,
    ],
    [titleMenuItems],
  );
  const snoozedMenuActions = useMemo<MenuAction[]>(
    () => [{ id: "unsnooze", title: "Wake thread", image: "clock" }, ...titleMenuItems],
    [titleMenuItems],
  );
  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "settle") void handleSettle();
      if (nativeEvent.event === "unsettle") handleUnsettle();
      if (nativeEvent.event === "unsnooze") handleUnsnooze();
      if (nativeEvent.event === "rename") handleRename();
      if (watchTarget && nativeEvent.event === "watch-pr") onSetPullRequestWatch(thread, watchTarget, true);
      if (watchTarget && nativeEvent.event === "stop-watching-pr") onSetPullRequestWatch(thread, watchTarget, false);
      if (nativeEvent.event === "copy-thread-id") {
        copyTextWithHaptic(record.sessionId, { target: "thread-id" });
      }
      const snoozeSelection = resolveThreadListV2SnoozeMenuSelection({
        event: nativeEvent.event,
        displayedPresets: snoozePresets,
        now: new Date(),
      });
      if (snoozeSelection._tag === "selected") {
        handleSnooze(snoozeSelection.preset.snoozedUntil);
      } else if (snoozeSelection._tag === "expired") {
        Alert.alert("Could not snooze thread", "That snooze time has passed. Choose another time.");
      }
    },
    [
      handleRename,
      handleSettle,
      handleSnooze,
      handleUnsettle,
      handleUnsnooze,
      onSetPullRequestWatch,
      record.sessionId,
      snoozePresets,
      thread,
      watchTarget,
    ],
  );
  const primaryAction = useMemo(() => {
    if (swipeActions.primary === "unsnooze") {
      return {
        accessibilityLabel: `Wake ${title} now`,
        icon: "clock" as const,
        label: "Wake",
        onPress: handleUnsnooze,
      };
    }
    return swipeActions.primary === "unsettle"
      ? {
          accessibilityLabel: `Un-settle ${title}`,
          icon: "arrow.uturn.backward" as const,
          label: "Un-settle",
          onPress: handleUnsettle,
        }
      : {
          accessibilityLabel: `Settle ${title}`,
          icon: "checkmark" as const,
          label: "Settle",
          onPress: (): void => void handleSettle(),
        };
  }, [handleSettle, handleUnsettle, handleUnsnooze, swipeActions.primary, title]);
  const secondaryAction = useMemo(
    () =>
      swipeActions.secondary === "snooze"
        ? {
            accessibilityLabel: `Choose when to snooze ${title}`,
            icon: "clock" as const,
            label: "Snooze",
            menu: {
              actions: snoozePresetActions,
              onPressAction: handleMenuAction,
              title: "Snooze until",
            },
            onPress: () => undefined,
          }
        : null,
    [handleMenuAction, snoozePresetActions, swipeActions.secondary, title],
  );
  const swipeAccessibilityHint =
    secondaryAction === null
      ? `Opens the thread. Swipe left to ${primaryAction.label.toLowerCase()}.`
      : `Opens the thread. Swipe left for ${primaryAction.label.toLowerCase()} and snooze actions.`;

  const favicon = (
    <ProjectFavicon
      environmentId={thread.hostId}
      size={15}
      projectTitle={props.projectTitle}
      workspaceRoot={props.projectPath}
    />
  );

  // Sidebar rows use navigation foregrounds on their active and idle surfaces.
  const cardContent = (
    <>
      <View className="flex-row items-center gap-1.5">
        {favicon}
        <Text
          className={cn(
            "flex-1 text-sm font-t3-medium",
            selected
              ? selectedThreadRowColors.mutedForegroundClassName
              : rowAppearance.mutedForegroundClassName,
          )}
          numberOfLines={1}
        >
          {props.projectTitle}
        </Text>
        <Text
          className={cn(
            "text-xs tabular-nums",
            statusLabel?.className ??
              (selected
                ? selectedThreadRowColors.foregroundClassName
                : rowAppearance.tertiaryForegroundClassName),
          )}
        >
          {statusLabel?.label ?? timeLabel}
        </Text>
      </View>
      <Text
        className={cn(
          "mt-1 text-base font-t3-medium",
          selected
            ? selectedThreadRowColors.foregroundClassName
            : rowAppearance.foregroundClassName,
        )}
        numberOfLines={2}
      >
        {title}
      </Text>
      <View className="mt-1 flex-row items-center gap-2">
        {record.branch || props.environmentLabel ? (
          /* "branch · host" share one truncating line. The host sits last so
             a tight fit cuts the repetitive label, not the branch — and
             host-only fills the row for non-git projects. */
          <View className="min-w-0 flex-1 flex-row items-center gap-1">
            <Text
              className={cn(
                "shrink text-xs",
                selected
                  ? selectedThreadRowColors.mutedForegroundClassName
                  : rowAppearance.mutedForegroundClassName,
              )}
              numberOfLines={1}
            >
              {record.branch ? (
                <Text
                  className={cn(
                    "text-xs",
                    selected
                      ? selectedThreadRowColors.mutedForegroundClassName
                      : rowAppearance.mutedForegroundClassName,
                  )}
                  style={{ fontFamily: MONO_FONT }}
                >
                  {record.branch}
                </Text>
              ) : null}
              {record.branch && props.environmentLabel ? "  ·  " : null}
              {props.environmentLabel ? (
                <Text
                  className={cn(
                    "text-xs",
                    selected
                      ? selectedThreadRowColors.mutedForegroundClassName
                      : rowAppearance.tertiaryForegroundClassName,
                  )}
                >
                  {props.environmentLabel}
                </Text>
              ) : null}
            </Text>
          </View>
        ) : (
          <View className="flex-1" />
        )}
        {pr ? (
          <View className="flex-row items-center gap-1" accessibilityLabel={pr.accessibilityLabel}>
            <SymbolView
              name="arrow.triangle.pull"
              size={12}
              tintColorClassName={
                pr.state === null || pr.isDraft
                  ? rowAppearance.mutedIconTintClassName
                  : pr.state === "open"
                    ? "accent-adaptive-emerald-600-400"
                    : pr.state === "closed"
                      ? "accent-adaptive-rose-600-400"
                      : "accent-adaptive-violet-600-400"
              }
            />
            <Text
              accessibilityLabel={pr.accessibilityLabel}
              className={cn("text-xs", pr.textClassName)}
              style={{ fontFamily: MONO_FONT }}
            >
              {pr.label}
            </Text>
            {pr.isWatched ? (
              <SymbolView
                name="eye"
                size={12}
                accessibilityLabel="Watched pull request"
                tintColorClassName={rowAppearance.mutedIconTintClassName}
              />
            ) : null}
          </View>
        ) : null}
        <ProviderInstanceIcon
          provider={record.provider}
          size={14}
          displayName={PROVIDER_DISPLAY_NAME[record.provider]}
          surfaceColor={rowAppearance.providerIconSurfaceColor}
        />
      </View>
    </>
  );

  const rowContent = (close: () => void) =>
    variant === "card" ? (
      <RowPressable
        key={thread.key}
        interactionClassName={rowAppearance.interactionClassName}
        interactionOpacity={rowAppearance.interactionOpacity}
        className={rowAppearance.className}
        accessibilityHint={swipeAccessibilityHint}
        accessibilityLabel={title}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        onPress={() => {
          close();
          onSelectThread(thread);
        }}
        style={rowAppearance.cardStyle}
      >
        {sidebarPane ? (
          cardContent
        ) : (
          /* Flat native list rows: no tonal containers — colored status
             labels and text hierarchy carry state, an inset hairline
             separates rows. The opaque screen background stays so swipe
             actions reveal behind the row. */
          <View>
            <View className={THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME}>{cardContent}</View>
            {THREAD_LIST_V2_ROW_DIVIDERS && props.showTrailingDivider !== false ? (
              <View className="ml-5 h-px bg-border-subtle" />
            ) : null}
          </View>
        )}
      </RowPressable>
    ) : (
      <RowPressable
        key={thread.key}
        interactionClassName={rowAppearance.interactionClassName}
        interactionOpacity={rowAppearance.interactionOpacity}
        accessibilityHint={swipeAccessibilityHint}
        accessibilityLabel={title}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        className={rowAppearance.className}
        onPress={() => {
          close();
          onSelectThread(thread);
        }}
        style={rowAppearance.style}
      >
        {/* Settled history recedes: dimmed favicon + muted title. */}
        <View
          className={cn(
            "min-h-[44px] flex-row items-center gap-2.5 py-2",
            sidebarPane ? "px-3" : "px-5",
          )}
        >
          <View className="opacity-40">{favicon}</View>
          <View className="min-w-0 flex-1">
            <Text
              className={cn(
                "text-base",
                selected
                  ? selectedThreadRowColors.foregroundClassName
                  : rowAppearance.mutedForegroundClassName,
              )}
              numberOfLines={1}
            >
              {title}
            </Text>
          </View>
          <Text
            className={cn(
              "text-sm tabular-nums",
              selected
                ? selectedThreadRowColors.mutedForegroundClassName
                : snoozedRow
                  ? rowAppearance.mutedForegroundClassName
                  : rowAppearance.tertiaryForegroundClassName,
            )}
            style={{ fontFamily: MONO_FONT }}
          >
            {snoozedRow && props.snoozeWakeLabelText !== undefined
              ? props.snoozeWakeLabelText
              : timeLabel}
          </Text>
        </View>
      </RowPressable>
    );

  return (
    <View collapsable={false}>
      <ThreadSwipeable
        dormant={dormant}
        threadKey={thread.key}
        backgroundColor={rowAppearance.swipeBackgroundColor}
        compactActions={variant === "slim"}
        containerStyle={rowAppearance.swipeContainerStyle}
        enableTrackpadSwipe
        // Full swipe commits the advertised lifecycle action (Settle /
        // Un-settle), never the secondary snooze action.
        fullSwipeAction="primary"
        fullSwipeWidth={props.fullSwipeWidth ?? windowWidth - 32}
        // No Delete: Solus has no way to delete a session from a list.
        onDelete={() => undefined}
        onSwipeableClose={props.onSwipeableClose}
        onSwipeableWillOpen={props.onSwipeableWillOpen}
        primaryAction={primaryAction}
        secondaryAction={secondaryAction}
        resetKey={`${thread.key}:${variant}:${snoozedRow}`}
        simultaneousWith={props.simultaneousSwipeGesture}
        threadTitle={title}
      >
        {(close) => (
          <ControlPillMenu
            actions={[
              { id: "copy-thread-id", title: "Copy thread ID", image: "doc.on.doc" },
              ...(snoozedRow
                ? snoozedMenuActions
                : canUnsettle
                  ? slimMenuActions
                  : swipeActions.secondary === "snooze"
                    ? snoozableCardMenuActions
                    : cardMenuActions),
            ]}
            onPressAction={handleMenuAction}
            shouldOpenOnLongPress
          >
            {rowContent(close)}
          </ControlPillMenu>
        )}
      </ThreadSwipeable>
    </View>
  );
});
