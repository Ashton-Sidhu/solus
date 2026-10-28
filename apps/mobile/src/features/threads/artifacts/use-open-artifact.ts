import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { SessionArtifact } from "@solus/contracts/session-artifacts";

import { useApp } from "../../../app/app-context";
import type { RootStackParamList } from "../../../navigation/routes";
import { openPullRequestLink } from "../../prs/lib/pull-request-link";
import { usePullRequestLinkActions } from "../../prs/use-pull-request-link-actions";
import { newThreadTarget } from "../new-thread-targets";

export interface ArtifactOpener {
  /** Whether the phone can open the item: works and automations have no screen here. */
  opens: (item: SessionArtifact) => boolean;
  open: (item: SessionArtifact) => void;
}

/**
 * Open what a session linked. Pull requests open their screen, or the browser
 * when no project of the host reads them; files and images open the file
 * screen of their host. The Artifacts screen and the session cards share it.
 */
export function useOpenArtifact(hostId: string, sessionId: string): ArtifactOpener {
  const app = useApp();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const pullRequestLinkActions = usePullRequestLinkActions();

  const workingDirectory =
    app.threads.thread(hostId, sessionId)?.record.cwd ??
    newThreadTarget(hostId, sessionId)?.workingDirectory ??
    "";

  const open = (item: SessionArtifact) => {
    switch (item.kind) {
      case "pull-request":
        if (openPullRequestLink(item.link.url, { hostId, workingDirectory }, pullRequestLinkActions) === null) {
          void app.platform.openBrowser(item.link.url);
        }
        return;
      case "file":
      case "image":
        navigation.navigate("File", {
          hostId: item.hostId,
          projectPath: item.hostId === hostId ? workingDirectory : "",
          path: item.path,
        });
        return;
      default:
        return;
    }
  };
  // A file on a host this device does not know cannot be read from here.
  const opens = (item: SessionArtifact) =>
    item.kind === "pull-request" ||
    ((item.kind === "file" || item.kind === "image") && app.registry.host(item.hostId) !== undefined);

  return { open, opens };
}
