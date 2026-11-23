import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, OrchestrationV2Subagent } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";
import { useRef, useState } from "react";
import { View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { IconButton } from "../../components/ui/IconButton";
import { mobileHost } from "../../state/mobile-host";
import { rememberSession } from "../../solus/session-record";
import { hostQueryScope, hostQueryScopeAtom } from "../../state/host-query-scope";
import { resourceAllows } from "@solus/contracts/permissions";
import {
  resolveSubagentRowPresentation,
  resolveSubagentStopTarget,
} from "./threadAgentsPresentation";

export function SubagentStopButton(props: {
  readonly environmentId: EnvironmentId;
  readonly subagent: OrchestrationV2Subagent;
  readonly className?: string;
}) {
  const gt = useGT();
  const messages = useMessages();
  const target = resolveSubagentStopTarget(props.subagent);
  const host = useAtomValue(mobileHost(props.environmentId));
  const scope = useAtomValue(hostQueryScopeAtom(props.environmentId));
  const [stopping, setStopping] = useState(false);
  const lock = useRef(false);
  const childId = props.subagent.childThreadId;
  if (target?.kind !== "subagent" || !host || !childId) return null;

  const label = resolveSubagentRowPresentation(props.subagent, false, messages).title;
  const stop = async () => {
    if (lock.current) return;
    lock.current = true;
    setStopping(true);
    try {
      if (hostQueryScope(props.environmentId) !== scope) throw new Error("The connection changed.");
      const child = await rememberSession(props.environmentId, childId);
      if (!resourceAllows(child, "drive.prompt") || hostQueryScope(props.environmentId) !== scope)
        throw new Error("You cannot stop this session.");
      if (!(await host.api.stopSession(childId)))
        throw new Error("The agent is no longer running.");
    } catch (error) {
      Dialog.alert(gt("Could not stop agent"), String(error));
    } finally {
      lock.current = false;
      setStopping(false);
    }
  };

  return (
    <View className={props.className}>
      <IconButton
        icon="stop.fill"
        variant="danger"
        accessibilityLabel={
          stopping ? gt("Stopping agent {label}", { label }) : gt("Stop agent {label}", { label })
        }
        disabled={stopping}
        onPress={() =>
          Dialog.confirm({
            title: gt("Stop agent?"),
            message: gt("Stop {label}?", { label }),
            confirmText: gt("Stop", { $context: "verb, confirm button" }),
            destructive: true,
            onConfirm: () => void stop(),
          })
        }
      />
    </View>
  );
}
