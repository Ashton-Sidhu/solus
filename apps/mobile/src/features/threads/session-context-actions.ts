import type { MenuAction } from "@react-native-menu/menu";
import type { RootStackParamList } from "../../navigation/routes";

/** Solus-only tools stay in the session row's context menu, outside T3's header. */
export const SESSION_CONTEXT_ACTIONS: MenuAction[] = [
  { id: "new-session", title: "New session", image: "square.and.pencil" },
  {
    id: "session-tools",
    title: "Session tools",
    subactions: [
      { id: "open-browser", title: "Browser", image: "globe" },
      { id: "open-devices", title: "Devices", image: "iphone" },
      { id: "open-artifacts", title: "Threads", image: "square.3.layers.3d" },
    ],
  },
];

export type SessionContextDestination =
  | ["ThreadBrowserPreview", RootStackParamList["ThreadBrowserPreview"]]
  | ["Devices", RootStackParamList["Devices"]]
  | ["ThreadArtifacts", RootStackParamList["ThreadArtifacts"]]
  | ["NewTask", RootStackParamList["NewTask"]]
  | ["Home", RootStackParamList["Home"]];

/** Resolve only these actions; existing settle/rename/watch actions keep their own handlers. */
export function sessionContextDestination(
  actionId: string,
  session: {
    readonly hostId: string;
    readonly sessionId: string;
    readonly projectPath: string | null;
  },
): SessionContextDestination | null {
  const { hostId, sessionId, projectPath } = session;
  switch (actionId) {
    case "open-browser":
      return ["ThreadBrowserPreview", { hostId, sessionId }];
    case "open-devices":
      return ["Devices", { hostId, sessionId }];
    case "open-artifacts":
      return ["ThreadArtifacts", { hostId, sessionId }];
    case "new-session":
      return ["NewTask", projectPath ? { hostId, projectPath } : { hostId }];
    case "open-pull-requests":
      return ["Home", { tab: "pullRequests", hostId }];
    default:
      return null;
  }
}
