import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { allSessionArtifacts } from "@solus/contracts/session-artifacts";
import { useState } from "react";

import type { RootStackParamList } from "../../navigation/routes";
import type { SessionArtifactsState } from "./artifacts/session-artifacts-feed";
import { chooseEnvironmentView, chosenEnvironmentView, environmentViewMenu, phoneEnvironmentFacts } from "./environment-view-menu";

/**
 * The thread header's environment menu. It counts the session's artifacts as
 * its Artifacts screen lists them, the whole delegation tree included, and
 * waits for that list, so it never names Browser and then Artifacts.
 * Artifacts opens that screen.
 */
export function useEnvironmentMenu(input: {
  readonly hostId: string;
  readonly sessionId: string;
  /** The list the Artifacts screen shows. */
  readonly artifacts: SessionArtifactsState;
}) {
  const { hostId, sessionId, artifacts } = input;
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  // Read per render, so a route reused for another session never shows this one's choice.
  const [, setChoiceVersion] = useState(0);
  return environmentViewMenu(
    phoneEnvironmentFacts({
      chosen: chosenEnvironmentView(hostId, sessionId),
      artifactCount: artifacts.kind === "ready" ? allSessionArtifacts(artifacts.artifacts).length : 0,
      // A failed read counts as answered; the Artifacts screen shows the failure.
      artifactsKnown: artifacts.kind !== "loading",
    }),
    (view) => {
      chooseEnvironmentView(hostId, sessionId, view);
      setChoiceVersion((version) => version + 1);
      if (view === "artifacts") navigation.navigate("ThreadArtifacts", { hostId, sessionId });
    },
  );
}
