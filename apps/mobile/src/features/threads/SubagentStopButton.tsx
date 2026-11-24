import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, OrchestrationV2Subagent } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
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
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        stopping ? gt("Stopping agent {label}", { label }) : gt("Stop agent {label}", { label })
      }
      accessibilityState={{ busy: stopping, disabled: stopping }}
      disabled={stopping}
      className={cn(
        "size-11 shrink-0 items-center justify-center active:opacity-70",
        props.className,
      )}
      onPress={() =>
        Dialog.confirm({
          title: gt("Stop agent?"),
          message: gt("Stop {label}?", { label }),
          confirmText: gt("Stop", { $context: "verb, confirm button" }),
          destructive: true,
          onConfirm: () => void stop(),
        })
      }
    >
      <View
        className={cn(
          "size-7 items-center justify-center rounded-full",
          stopping ? "bg-subtle-strong" : "bg-danger",
        )}
      >
        <SymbolView
          name="stop.fill"
          size={12}
          tintColorClassName={stopping ? "accent-icon-subtle" : "accent-danger-foreground"}
        />
      </View>
    </Pressable>
  );
}
