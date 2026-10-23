// Adapted from T3 Code apps/mobile/src/widgets/AgentActivity.tsx (MIT, see UPSTREAM.md).
import { Circle, HStack, Image, Spacer, Text, VStack, ZStack } from "@expo/ui/swift-ui";
import type { ComponentProps } from "react";
import {
  accessibilityElement,
  accessibilityLabel,
  activityBackgroundTint,
  font,
  foregroundStyle,
  frame,
  layoutPriority,
  lineLimit,
  minimumScaleFactor,
  padding,
  resizable,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import {
  createLiveActivity,
  type LiveActivityComponent,
  type LiveActivityLayout,
} from "expo-widgets";
import { AGENT_ACTIVITY_NAME, type AgentActivityCard, type AgentActivityPhase, type AgentActivityRow } from "@solus/contracts/uplink";

type LiveActivityEnvironment = Parameters<LiveActivityComponent<AgentActivityCard>>[1];

// This function is serialized into the widget extension's JS bundle, so it
// must stay self-contained: no references to module-scope helpers, only the
// imported view/modifier factories.
export function AgentActivity(
  props: AgentActivityCard,
  environment: LiveActivityEnvironment,
): LiveActivityLayout {
  "widget";

  // Hierarchical styles inherit the system's foreground treatment, including
  // tinted and vibrant presentations, rather than resolving to a label color.
  type Foreground = Parameters<typeof foregroundStyle>[0];
  const primaryForeground = { type: "hierarchical", style: "primary" } as const;
  const secondaryForeground = { type: "hierarchical", style: "secondary" } as const;
  // This expo-widgets release reports no rendering mode to Live Activities
  // (T3 patches it in); hierarchical styles already follow tinted hosts.
  const monochrome = false;

  // The Lock Screen card always wears the app's dark theme
  // (src/theme/theme-colors.ts SOLUS_DARK_THEME_COLORS: canvas, text,
  // textMuted), in light and dark system appearance alike, instead of
  // the default black material. The Dynamic Island is always black, so it
  // keeps the hierarchical styles.
  const cardBackground = "#262522";
  const cardForeground: Foreground = "#f0ede5";
  const cardMutedForeground: Foreground = "#9a978f";

  // Status tints are the app thread list's dark ones (thread-list-v2-items.tsx,
  // generated-uniwind-theme.css): amber for approval and limits, the
  // accent for input, red for failures, blue for working, and the workspace's
  // complete green for done.
  const phaseTint = (phase: AgentActivityPhase | undefined): Foreground => {
    if (environment.isLuminanceReduced) {
      return cardMutedForeground;
    }
    if (monochrome) {
      return primaryForeground;
    }
    switch (phase) {
      case "waiting_for_approval":
      case "limited":
        return "#fbbf24"; // dark amber
      case "waiting_for_input":
        return "#e68e6b"; // dark accent
      case "failed":
        return "#ef4444"; // dark red
      case "completed":
        return "#6fc884"; // dark --solus-status-complete
      case "stale":
        return cardMutedForeground;
      case "starting":
      case "running":
      default:
        return "#83a2ec"; // dark --color-adaptive-sky-600-400 (Working)
    }
  };

  // Order attention-first so whatever needs the user floats to the top of every
  // presentation, then failures, then in-flight work, then finished/stale.
  const phasePriority = (phase: AgentActivityPhase): number => {
    if (phase === "waiting_for_approval" || phase === "waiting_for_input") return 0;
    if (phase === "failed") return 1;
    if (phase === "running" || phase === "starting" || phase === "limited") return 2;
    return 3;
  };
  // Past the stale date the system stops vouching for the content, so every
  // in-flight row degrades to "stale" rather than claiming an agent is still
  // working. Terminal phases keep their own state.
  const activities: ReadonlyArray<AgentActivityRow> = environment.isStale
    ? props.activities.map((row) =>
        row.phase === "completed" || row.phase === "failed"
          ? row
          : { ...row, phase: "stale", status: "Out of date" },
      )
    : props.activities;
  const ordered = [...activities].sort((a, b) => phasePriority(a.phase) - phasePriority(b.phase));
  const row0 = ordered[0];
  const row1 = ordered[1];
  const row2 = ordered[2];
  const row3 = ordered[3];
  const row4 = ordered[4];

  const attentionRows = activities.filter(
    (row) => row.phase === "waiting_for_approval" || row.phase === "waiting_for_input",
  );
  const attentionRow = attentionRows[0];
  const failedRow = activities.find((row) => row.phase === "failed");
  const heroRow = attentionRow ?? failedRow ?? row0;
  const tint = phaseTint(heroRow?.phase);
  // Headline count leans on the accent when a human is actually blocked.
  const headerTint = attentionRow
    ? phaseTint(attentionRow.phase)
    : failedRow
      ? phaseTint(failedRow.phase)
      : tint;

  // With nothing active the aggregate only carries recently finished work, so
  // "0 active agents" (and a lone "0" in the expanded island) read as broken.
  // Lead with the outcome instead. The outcome is derived here from the rows
  // rather than taken from the server subtitle (which keys off the newest
  // terminal row): every presentation — header text, tint, count slots,
  // minimal glyph — must agree, and a failure anywhere should dominate a
  // newer success.
  const allDone = props.activeCount === 0;
  const doneLabel = failedRow ? "Failed" : "Done";
  const outcomeLabel = failedRow ? "Agent work failed" : "Agent work completed";

  // Header copy: "5 active agents" + (", 1 needs attention"). The banner renders
  // the two parts in-line so the attention half can carry the accent color;
  // `summary` is the short form for tight spots (expanded center, watch card).
  const agentWord = props.activeCount === 1 ? "agent" : "agents";
  const agentsLabel = allDone
    ? outcomeLabel
    : environment.isStale
      ? "Agent status out of date"
      : `${props.activeCount} active ${agentWord}`;
  const attentionSuffix =
    attentionRows.length > 0
      ? `${attentionRows.length} need${attentionRows.length === 1 ? "s" : ""} attention`
      : "";
  const activeLabel = allDone
    ? doneLabel
    : environment.isStale
      ? "Out of date"
      : `${props.activeCount} active`;
  // The compact slot is narrow when another Live Activity shares the island:
  // show the count as digits in a circle, capped at 99+. The accessibility
  // label keeps the full count.
  const showCompactCount = !attentionRow && !allDone && !environment.isStale;
  const compactCountLabel = props.activeCount > 99 ? "99+" : `${props.activeCount}`;
  const summary = attentionSuffix || activeLabel;

  // Taps open the app's `solus://` scheme at the session that needs the
  // person, else the first row's.
  const deepLinkRow = attentionRow ?? row0;
  const deepLink =
    deepLinkRow && deepLinkRow.deepLink.startsWith("/") && !deepLinkRow.deepLink.startsWith("//")
      ? `solus://${deepLinkRow.deepLink.slice(1)}`
      : null;

  // A scannable status glyph per phase — reads faster than colored words and
  // ties the compact / expanded / banner / watch presentations together.
  type SFName = NonNullable<ComponentProps<typeof Image>["systemName"]>;
  const phaseSymbol = (phase: AgentActivityPhase): SFName => {
    switch (phase) {
      case "waiting_for_approval":
        return "exclamationmark.circle.fill";
      case "waiting_for_input":
        return "questionmark.circle.fill";
      case "failed":
        return "xmark.octagon.fill";
      case "completed":
        return "checkmark.circle.fill";
      case "limited":
        return "clock";
      case "starting":
        return "circle.dotted";
      case "stale":
        return "clock.arrow.circlepath";
      case "running":
      default:
        return "arrow.triangle.2.circlepath";
    }
  };

  // SF Symbols, like the logo, ignore frame/foregroundStyle applied directly to
  // the image; size + tint them through a container the resizable symbol fills.
  const renderGlyph = (systemName: SFName, size: number, color: Foreground) => (
    <HStack modifiers={[frame({ width: size, height: size }), foregroundStyle(color)]}>
      <Image systemName={systemName} modifiers={[resizable()]} />
    </HStack>
  );

  // Single-line row used by every presentation: glyph, title, inline project,
  // status. The project and status carry layoutPriority(1) so when space runs
  // out it's the title that truncates, never the (short) project name or the
  // status label. Single-line keeps rows inside the expanded island's hard
  // height budget (~160pt) and lets the banner fit more agents.
  const renderCompactRow = (
    row: AgentActivityRow,
    textColor: Foreground,
    mutedColor: Foreground,
  ) => (
    <HStack spacing={7} alignment="center">
      <Text
        modifiers={[
          font({ weight: "semibold", size: 13 }),
          foregroundStyle(textColor),
          lineLimit(1),
        ]}
      >
        {row.threadTitle}
      </Text>
      {/* No layoutPriority and no frame on the project: two bare texts take
          their ideal width when it fits and shrink proportionally only when it
          doesn't — so short rows never truncate, and long title + long project
          truncate together. (A maxWidth frame is greedy and reserved its full
          width even for short names; layoutPriority let the project starve the
          title.) */}
      <Text modifiers={[font({ size: 11 }), foregroundStyle(mutedColor), lineLimit(1)]}>
        {row.projectTitle}
      </Text>
      <Spacer minLength={8} />
      <Text
        modifiers={[
          font({ weight: "semibold", size: 11 }),
          foregroundStyle(phaseTint(row.phase)),
          layoutPriority(1),
        ]}
      >
        {row.status}
      </Text>
    </HStack>
  );

  // The Solus mark in its brand colours. `assetName` resolves the full-colour
  // image set bundled in the widget extension's asset catalog
  // (plugins/withWidgetLogoAsset.cjs); it renders as the original image, so
  // it takes no tint. Image views only honor `resizable` directly, so it is
  // sized through a container frame. The mark is square.
  const renderLogo = (height: number) => (
    <HStack modifiers={[frame({ width: height, height })]}>
      <Image assetName="SolusMark" modifiers={[resizable()]} />
    </HStack>
  );

  return {
    banner: (
      <VStack
        alignment="leading"
        spacing={6}
        modifiers={[
          padding({ all: 14 }),
          activityBackgroundTint(cardBackground),
          ...(deepLink ? [widgetURL(deepLink)] : []),
        ]}
      >
        {/* Logo pinned to the leading edge; the status texts centered across the
            full width (ZStack so the logo doesn't skew the centering). No footer —
            overflow beyond the visible rows is inferable from the count. */}
        <ZStack>
          <HStack spacing={0} alignment="center">
            {renderLogo(13)}
            <Spacer minLength={0} />
          </HStack>
          <HStack spacing={6} alignment="center">
            <Spacer minLength={0} />
            <Text
              modifiers={[
                font({ weight: "semibold", size: 13 }),
                // The all-done header carries the outcome tint (emerald /
                // red) the way the Done/Failed status labels do.
                foregroundStyle(allDone ? headerTint : cardForeground),
                lineLimit(1),
              ]}
            >
              {agentsLabel}
            </Text>
            {attentionSuffix ? (
              <Text modifiers={[font({ size: 13 }), foregroundStyle(cardMutedForeground)]}>·</Text>
            ) : null}
            {attentionSuffix ? (
              <Text
                modifiers={[
                  font({ weight: "semibold", size: 13 }),
                  foregroundStyle(headerTint),
                  lineLimit(1),
                ]}
              >
                {attentionSuffix}
              </Text>
            ) : null}
            <Spacer minLength={0} />
          </HStack>
        </ZStack>
        {row0 ? renderCompactRow(row0, cardForeground, cardMutedForeground) : null}
        {row1 ? renderCompactRow(row1, cardForeground, cardMutedForeground) : null}
        {row2 ? renderCompactRow(row2, cardForeground, cardMutedForeground) : null}
        {row3 ? renderCompactRow(row3, cardForeground, cardMutedForeground) : null}
        {row4 ? renderCompactRow(row4, cardForeground, cardMutedForeground) : null}
      </VStack>
    ),
    // Compact card for the watchOS Smart Stack + CarPlay (the `.small` family):
    // brand + count, then the single most important agent with its status glyph.
    bannerSmall: (
      <VStack alignment="leading" spacing={5} modifiers={[padding({ all: 10 })]}>
        <HStack spacing={7} alignment="center">
          {renderLogo(14)}
          <Text
            modifiers={[
              font({ weight: "bold", size: 13 }),
              foregroundStyle(headerTint),
              lineLimit(1),
            ]}
          >
            {attentionRows.length > 0 ? summary : activeLabel}
          </Text>
          <Spacer minLength={6} />
        </HStack>
        {row0 ? (
          <HStack spacing={7} alignment="center">
            <Text
              modifiers={[
                font({ weight: "semibold", size: 12 }),
                foregroundStyle(primaryForeground),
                lineLimit(1),
              ]}
            >
              {row0.threadTitle}
            </Text>
            <Spacer minLength={6} />
            <Text modifiers={[font({ size: 11 }), foregroundStyle(phaseTint(row0.phase))]}>
              {row0.status}
            </Text>
          </HStack>
        ) : null}
      </VStack>
    ),
    compactLeading: renderLogo(14),
    compactTrailing: showCompactCount ? (
      <ZStack
        modifiers={[
          frame({ width: 28, height: 28 }),
          accessibilityElement("ignore"),
          accessibilityLabel(agentsLabel),
        ]}
      >
        <Circle modifiers={[foregroundStyle(tint)]} />
        <Text
          modifiers={[
            font({ weight: "bold", size: 14 }),
            foregroundStyle("#000000"),
            lineLimit(1),
            minimumScaleFactor(0.75),
            frame({ width: 24, height: 28 }),
          ]}
        >
          {compactCountLabel}
        </Text>
      </ZStack>
    ) : (
      <Text
        modifiers={[
          font({ weight: "semibold", size: 11 }),
          foregroundStyle(tint),
          lineLimit(1),
          minimumScaleFactor(0.5),
        ]}
      >
        {attentionRow
          ? attentionRow.phase === "waiting_for_approval"
            ? "Approval"
            : "Input"
          : activeLabel}
      </Text>
    ),
    // The shared/minimal form is a ~22pt circle — a single signal reads there,
    // the wordmark does not. Show the blocking/outcome phase glyph, else the
    // mark (all-done shows the hero row's checkmark/cross).
    minimal:
      (attentionRow || failedRow || allDone) && heroRow
        ? renderGlyph(phaseSymbol(heroRow.phase), 13, phaseTint(heroRow.phase))
        : renderLogo(11),
    expandedLeading: (
      <HStack spacing={5} alignment="center" modifiers={[padding({ leading: 4, vertical: 4 })]}>
        {renderLogo(15)}
        <Text modifiers={[font({ weight: "bold", size: 13 }), foregroundStyle(tint)]}>
          {allDone ? doneLabel : `${props.activeCount}`}
        </Text>
      </HStack>
    ),
    // No center content: the phase glyphs + statuses in expandedBottom already
    // carry the attention signal, and the expanded island's height budget is
    // tight enough that a summary line there pushed the third row off.
    expandedCenter: null,
    // No trailing content: a timestamp is glanceable-lock-screen info, not
    // useful in a view the user is actively holding open — and the trailing
    // region hugs the island's corner radius, which clipped it anyway.
    expandedTrailing: null,
    expandedBottom: (
      // Vertical padding only: the expanded region provides its own horizontal
      // content margins, so `all` padding double-indented the rows.
      // Horizontal padding keeps both edges clear of the island's corner
      // curvature (right edge clipped status labels; titles hugged the left).
      <VStack
        alignment="leading"
        spacing={5}
        modifiers={
          deepLink
            ? [padding({ vertical: 2, horizontal: 8 }), widgetURL(deepLink)]
            : [padding({ vertical: 2, horizontal: 8 })]
        }
      >
        {row0 ? renderCompactRow(row0, primaryForeground, secondaryForeground) : null}
        {row1 ? renderCompactRow(row1, primaryForeground, secondaryForeground) : null}
        {row2 ? renderCompactRow(row2, primaryForeground, secondaryForeground) : null}
      </VStack>
    ),
  };
}

export default createLiveActivity<AgentActivityCard>(AGENT_ACTIVITY_NAME, AgentActivity);
