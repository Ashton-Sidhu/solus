// Adapted from T3 Code's draft route (MIT, see UPSTREAM.md).
import { StackActions } from "@react-navigation/native";
import { useLayoutEffect } from "react";
import { useApp } from "../../app/app-context";
import type { ScreenProps } from "../../navigation/routes";
import { NewTaskProjectScreen } from "./NewTaskProjectScreen";
import { NewTaskConnectHost, useNewTaskHostGate } from "./NewTaskConnectHost";

/** Existing commands can name NewTask; a chosen project opens the draft as a Thread. */
export function NewTaskRouteScreen({ route, navigation }: ScreenProps<"NewTask">) {
  const app = useApp();
  const hostGate = useNewTaskHostGate();
  const hostId = route.params?.hostId;
  const projectPath = route.params?.projectPath;
  useLayoutEffect(() => {
    if (hostGate === "connect" || !hostId || !projectPath) return;
    navigation.dispatch(StackActions.replace("Thread", {
      hostId, sessionId: app.newSessionId(), draft: { ...route.params, projectPath },
    }));
  }, [app, hostGate, hostId, projectPath, navigation, route.params]);
  if (hostGate === "connect") {
    return <NewTaskConnectHost
      draftText={hostId && projectPath ? app.draft(hostId, `new-task:${projectPath}`).trim() : ""}
      onClose={() => navigation.goBack()}
    />;
  }
  if (hostId && projectPath) return null;
  return <NewTaskProjectScreen preferredHostId={hostId ?? null} taskId={route.params?.taskId} taskHostId={route.params?.taskHostId} />;
}
