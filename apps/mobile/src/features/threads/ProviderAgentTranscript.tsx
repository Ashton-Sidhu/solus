import { useAtomValue } from "@effect/atom-react";
import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { SubagentHistoryStore } from "@solus/client-core/subagent-history-store";
import { TranscriptModel } from "@solus-mobile/features/conversation/lib/transcript-model";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { View } from "react-native";
import { useGT } from "gt-react-native";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { hostQueryScopeAtom } from "../../state/host-query-scope";
import { mobileHost } from "../../state/mobile-host";
import type { AgentId } from "@solus/contracts/types";
import { remoteAgentChild } from "../../solus/agent-child-host";
import { conversationFeed } from "../../solus/conversation-feed";
import { useSessionController } from "../../solus/use-session-controller";
import { ReadOnlyThreadHistory } from "./LinkedThreadSheet";

type Target = {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  toolId: string;
  title: string | null;
};

export function ProviderAgentTranscript({ route }: StaticScreenProps<Target>) {
  const gt = useGT();
  const target = route.params;
  const navigation = useNavigation();
  const controller = useSessionController(target);
  const host = useAtomValue(mobileHost(target.environmentId));
  const scope = useAtomValue(hostQueryScopeAtom(target.environmentId));
  const source = controller?.historySource;
  const history = useMemo(
    () =>
      host && source && new SubagentHistoryStore(host.api, { ...source, toolId: target.toolId }),
    [host, scope, target.toolId, source?.sessionId, source?.provider, source?.projectPath],
  );
  const readToolInput = useCallback(
    async (key: string) => {
      if (!controller) throw new Error("The session is unavailable.");
      return controller.readToolInput(key);
    },
    [controller],
  );
  return (
    <View className="flex-1 bg-sheet">
      <SheetHeader
        title={target.title || gt("Agent transcript")}
        onClose={() => navigation.goBack()}
      />
      <ScreenContent>
        {history && controller ? (
          <Transcript
            key={JSON.stringify([scope, target.threadId, target.toolId])}
            history={history}
            sessionId={target.threadId}
            environmentId={target.environmentId}
            provider={controller.run.provider}
            readToolInput={readToolInput}
          />
        ) : (
          <EmptyState
            title={gt("Agent transcript unavailable")}
            detail={gt("Connect to the session host to read this transcript.")}
          />
        )}
      </ScreenContent>
    </View>
  );
}

function Transcript({
  history,
  sessionId,
  environmentId,
  provider,
  readToolInput,
}: {
  history: SubagentHistoryStore;
  sessionId: string;
  environmentId: EnvironmentId;
  provider: AgentId;
  readToolInput: (key: string) => Promise<string>;
}) {
  const gt = useGT();
  const state = useSyncExternalStore(history.subscribe, history.read);
  const [older, setOlder] = useState(false);
  useEffect(() => {
    void history.load();
  }, [history]);
  const feed = useMemo(() => {
    const model = TranscriptModel.fromHistory(sessionId, state.page);
    return conversationFeed(
      { item: (key) => model.items.get(key), subscribeFeedItems: () => () => {} },
      sessionId,
      () => null,
      async () => {
        throw new Error("This attachment is unavailable.");
      },
      readToolInput,
      { provider, child: remoteAgentChild(environmentId) },
    )(model.order).get();
  }, [sessionId, state.page, readToolInput, provider, environmentId]);
  const load = (earlier: boolean) => {
    setOlder(earlier);
    return history.load(earlier);
  };
  return (
    <>
      <ReadOnlyThreadHistory
        label={gt("host")}
        view={{
          feed,
          ready: state.phase === "ready" || state.page.messages.length > 0,
          paging: state.phase === "loading",
          hasOlder: !!state.page.before,
          error: state.error ?? null,
          retry: () => load(older),
          loadEarlier: () => load(true),
        }}
      />
      <Button
        label={gt("Refresh transcript")}
        tone="text"
        disabled={state.phase === "loading"}
        onPress={() => load(false)}
      />
    </>
  );
}
