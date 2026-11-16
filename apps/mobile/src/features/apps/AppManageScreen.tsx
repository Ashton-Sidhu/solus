import { useCallback } from "react";
import { Platform, View } from "react-native";
import { useResolveClassNames } from "uniwind";

import type { HostApi } from "@solus/client-core/host-api";
import type { AppSummary } from "@solus/contracts/apps";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { RowLeadingSymbol } from "../../components/RowLeadingSymbol";
import { RowPressable } from "../../components/RowPressable";
import { cn } from "../../lib/cn";
import type { ScreenProps } from "../../navigation/routes";
import { SettingsSection } from "../settings/components/SettingsSection";
import { AppListRow, AppPage, AppStateBody } from "./app-rows";
import { runsRequest } from "./app-runs";
import { appProblems, appSectionRows, appSectionTitle, type AppSectionId, type AppSectionRow } from "./app-sections";
import { useAppRead, useAppState } from "./use-app";

/**
 * The Manage screen of one app (docs/plans/apps.md §9.2): what needs the
 * owner at the top, each problem leading to the section where they act, then
 * the sections. A row says the one fact a person scans for and opens the
 * screen of its section.
 */
export function AppManageScreen({ navigation, route }: ScreenProps<"AppManage">) {
  const { hostId, appId } = route.params;
  const { state, connected, isDeleted, reload } = useAppState(hostId, appId, { followsActivity: true });
  // The summary of Workflows counts the runs in progress, which the app's state does not hold.
  const readRuns = useCallback((api: HostApi) => api.appRuns(runsRequest(appId, null)), [appId]);
  const runs = useAppRead(hostId, appId, "runs", readRuns);
  const loaded = state.kind === "loaded" ? state.value : null;
  const open = (section: AppSectionId) => {
    if (loaded) navigation.navigate("AppSection", { hostId, appId: loaded.app.id, section });
  };

  return (
    <AppPage title={loaded?.app.name ?? "Manage"} hostId={hostId}>
      <AppStateBody state={state} connected={connected} isDeleted={isDeleted} onRetry={reload}>
        {(app) => (
          <>
            <Problems app={app.app} onOpen={open} onOpenRun={(runId) => navigation.navigate("AppRun", { hostId, appId: app.app.id, runId })} />
            <SettingsSection title="Manage">
              {appSectionRows(app, runs.state.kind === "loaded" ? runs.state.value : null).map((row, index) => (
                <SectionRow key={row.id} row={row} first={index === 0} onPress={() => open(row.id)} />
              ))}
            </SettingsSection>
          </>
        )}
      </AppStateBody>
    </AppPage>
  );
}

/** What needs the owner. A row opens the section where they act on it, or the run that failed on an older version. */
function Problems(props: { readonly app: AppSummary; readonly onOpen: (section: AppSectionId) => void; readonly onOpenRun: (runId: string) => void }) {
  const problems = appProblems(props.app);
  if (problems.length === 0) return null;
  return (
    <SettingsSection title={problems.length === 1 ? "Needs you" : `Needs you · ${problems.length}`}>
      {problems.map((problem, index) => (
        <AppListRow
          key={`${problem.section}:${problem.detail}`}
          first={index === 0}
          mark={{ state: "warning" }}
          title={appSectionTitle(problem.section)}
          lines={[{ text: problem.detail, tone: problem.tone }]}
          onPress={() => (problem.runId ? props.onOpenRun(problem.runId) : props.onOpen(problem.section))}
        />
      ))}
    </SettingsSection>
  );
}

/** One section of the Manage screen: its symbol, its name, and its summary. */
function SectionRow(props: { readonly row: AppSectionRow; readonly first: boolean; readonly onPress: () => void }) {
  const { row } = props;
  const rippleStyle = useResolveClassNames("bg-subtle-strong");
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={`${row.title}, ${row.summary.text}`}
      onPress={props.onPress}
      android_ripple={{ color: rippleStyle.backgroundColor }}
      unstable_pressDelay={Platform.OS === "android" ? 50 : undefined}
      className={cn("bg-grouped-card", !props.first && "border-t border-border-subtle")}
    >
      <View className="min-h-18 flex-row items-center gap-3 px-4 py-3">
        <View className="size-6 items-center justify-center">
          <RowLeadingSymbol name={row.icon} />
        </View>
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-base text-foreground">{row.title}</Text>
          <Text className={cn("text-sm", row.summary.tone === "danger" ? "text-danger-foreground" : "text-foreground-muted")}>
            {row.summary.text}
          </Text>
        </View>
        <SymbolView name="chevron.right" size={16} tintColorClassName="accent-chevron" type="monochrome" weight="semibold" />
      </View>
    </RowPressable>
  );
}
