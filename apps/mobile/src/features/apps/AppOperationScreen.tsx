import { useState } from "react";
import { TextInput, View } from "react-native";

import { appCallValue } from "@solus/client-core/app-calls";
import { appOperationCallName, type AppOperation } from "@solus/contracts/apps";

import { ListRowLayout } from "../../components/ListRowLayout";
import type { ScreenProps } from "../../navigation/routes";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsNote } from "../settings/components/SettingsNote";
import { SettingsSection } from "../settings/components/SettingsSection";
import { errorMessage } from "../settings/integrations";
import { AppPage, AppStateBody, MonoBlock } from "./app-rows";
import { jsonText, operationKindLabel, parseOperationInput } from "./apps";
import { useAppHostCall, useAppState } from "./use-app";

/** How one run from the form ended. */
type RunResult = { readonly kind: "value"; readonly text: string } | { readonly kind: "error"; readonly message: string };

/**
 * One operation of an app (docs/plans/apps.md §9.2): what it is, its
 * schemas, and a form to run it with a JSON input. The run is a call of the
 * app's UI: it is in the call log, and an operation never asks (decision 13).
 */
export function AppOperationScreen({ route }: ScreenProps<"AppOperation">) {
  const { hostId, appId, operation: operationName } = route.params;
  const { state, connected, isDeleted, reload } = useAppState(hostId, appId);

  return (
    <AppPage title={operationName} hostId={hostId}>
      <AppStateBody state={state} connected={connected} isDeleted={isDeleted} onRetry={reload}>
        {(app) => {
          const operation = app.descriptor?.operations.find((entry) => entry.name === operationName);
          return operation ? (
            <OperationDetail hostId={hostId} appId={app.app.id} operation={operation} stopped={app.app.stopped} connected={connected} />
          ) : (
            <SettingsNote>The active version of this app does not declare this operation.</SettingsNote>
          );
        }}
      </AppStateBody>
    </AppPage>
  );
}

function OperationDetail(props: {
  readonly hostId: string;
  readonly appId: string;
  readonly operation: AppOperation;
  readonly stopped: boolean;
  readonly connected: boolean;
}) {
  const { operation } = props;
  const callHost = useAppHostCall(props.hostId, props.appId);
  const [input, setInput] = useState("{}");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);

  const run = () => {
    const parsed = parseOperationInput(input);
    if (!parsed.ok) {
      setResult({ kind: "error", message: parsed.message });
      return;
    }
    setRunning(true);
    setResult(null);
    void callHost(appOperationCallName(operation.name), parsed.argumentsJson)
      .then(
        (answer) => setResult({ kind: "value", text: jsonText(appCallValue(answer)) }),
        (cause: unknown) => setResult({ kind: "error", message: errorMessage(cause) }),
      )
      .finally(() => setRunning(false));
  };

  return (
    <>
      <View className="gap-3">
        <SettingsSection title="Operation">
          <ListRowLayout
            icon="terminal"
            label={operationKindLabel(operation.kind)}
            description={operation.kind === "query" ? "It reads. It gets a read-only database." : "It writes."}
          />
          <ListRowLayout label="Time limit" detail={`${operation.timeoutSeconds ?? 60} s`} />
        </SettingsSection>
        {operation.description ? <SettingsNote>{operation.description}</SettingsNote> : null}
      </View>

      <SettingsSection title="Input schema">
        <View className="p-4">
          <MonoBlock text={jsonText(operation.input)} />
        </View>
      </SettingsSection>

      <SettingsSection title="Output schema">
        <View className="p-4">
          {operation.output ? <MonoBlock text={jsonText(operation.output)} /> : <SettingsNote>This operation declares no output schema.</SettingsNote>}
        </View>
      </SettingsSection>

      <View className="gap-3">
        <SettingsSection title="Run">
          <View className="p-4">
            <TextInput
              accessibilityLabel="Input as JSON"
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
              placeholder="{}"
              value={input}
              onChangeText={setInput}
              className="min-h-24 rounded-2xl border border-border bg-input px-3.5 py-3 font-mono text-sm text-foreground"
            />
          </View>
          <SettingsActionRow
            icon="play"
            label={operation.kind === "query" ? "Run the query" : "Run the mutation"}
            disabled={!props.connected || running}
            loading={running}
            onPress={run}
          />
        </SettingsSection>
        <SettingsNote>
          {props.stopped
            ? "This app is stopped: the host refuses the run until you start the app."
            : "The input is a JSON object. The run is a call from the app UI, and the call log keeps it."}
        </SettingsNote>
        {result?.kind === "error" ? <SettingsNote tone="danger">{result.message}</SettingsNote> : null}
      </View>

      {result?.kind === "value" ? (
        <SettingsSection title="Result">
          <View className="p-4">
            <MonoBlock text={result.text} />
          </View>
        </SettingsSection>
      ) : null}
    </>
  );
}
