import type { ScreenProps } from "../../navigation/routes";
import { AppPage, AppStateBody } from "./app-rows";
import { appSectionTitle, type AppSectionId } from "./app-sections";
import { ActivitySection } from "./sections/ActivitySection";
import { ConfigSection } from "./sections/ConfigSection";
import { FilesSection } from "./sections/FilesSection";
import { OperationsSection } from "./sections/OperationsSection";
import { OverviewSection } from "./sections/OverviewSection";
import { SchedulesSection } from "./sections/SchedulesSection";
import { SecretsSection } from "./sections/SecretsSection";
import type { AppSectionProps } from "./sections/section-props";
import { SessionsSection } from "./sections/SessionsSection";
import { SignalsSection } from "./sections/SignalsSection";
import { SourceSection } from "./sections/SourceSection";
import { VersionsSection } from "./sections/VersionsSection";
import { WebhooksSection } from "./sections/WebhooksSection";
import { WorkflowsSection } from "./sections/WorkflowsSection";
import { useAppState } from "./use-app";

/**
 * One section of the Manage screen (docs/plans/apps.md §9.2) as its own
 * screen. The screen reads the app; the section reads what it lists and runs
 * its own changes. Each way in has its way back in the same section.
 */
export function AppSectionScreen({ navigation, route }: ScreenProps<"AppSection">) {
  const { hostId, appId, section } = route.params;
  // Only the Overview shows what the activity of the app counts: the runner and the calls in progress.
  const { state, connected, isDeleted, reload } = useAppState(hostId, appId, { followsActivity: section === "overview" });

  return (
    <AppPage title={appSectionTitle(section)} hostId={hostId}>
      <AppStateBody state={state} connected={connected} isDeleted={isDeleted} onRetry={reload}>
        {(app) => (
          <Section
            section={section}
            hostId={hostId}
            appId={app.app.id}
            state={app}
            connected={connected}
            reloadState={reload}
            navigation={navigation}
          />
        )}
      </AppStateBody>
    </AppPage>
  );
}

function Section({ section, ...props }: AppSectionProps & { readonly section: AppSectionId }) {
  switch (section) {
    case "overview":
      return <OverviewSection {...props} />;
    case "activity":
      return <ActivitySection {...props} />;
    case "workflows":
      return <WorkflowsSection {...props} />;
    case "versions":
      return <VersionsSection {...props} />;
    case "schedules":
      return <SchedulesSection {...props} />;
    case "webhooks":
      return <WebhooksSection {...props} />;
    case "signals":
      return <SignalsSection {...props} />;
    case "secrets":
      return <SecretsSection {...props} />;
    case "config":
      return <ConfigSection {...props} />;
    case "files":
      return <FilesSection {...props} />;
    case "operations":
      return <OperationsSection {...props} />;
    case "sessions":
      return <SessionsSection {...props} />;
    case "source":
      return <SourceSection {...props} />;
  }
}
