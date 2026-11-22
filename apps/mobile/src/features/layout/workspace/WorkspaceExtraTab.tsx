import { SettingsEnvironmentFilterProvider } from "../../settings/settings-environment-filter";
import { type NavigationTab } from "./navigation-tab-order";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { UsageSettings } from "../../../solus/UsageVoiceSettings";

export function WorkspaceExtraTab(_props: { tab: Extract<NavigationTab, "usage"> }) {
  return (
    <>
      <NativeStackScreenOptions options={{ headerSearchBarOptions: undefined }} />
      <SettingsEnvironmentFilterProvider open><UsageSettings workspace /></SettingsEnvironmentFilterProvider>
    </>
  );
}
