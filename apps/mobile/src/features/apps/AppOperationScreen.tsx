import { useState } from "react";
import { TextInput, View } from "react-native";

import { appCallValue } from "@solus/client-core/app-calls";
import { operationFields, operationInputTemplate, operationKindLabel, operationTimeLimitText, type OperationField } from "@solus/client-core/app-operations";
import { appOperationCallName, type AppOperation } from "@solus/contracts/apps";

import { ListRow } from "../../components/ListRow";
import { ListRowLayout } from "../../components/ListRowLayout";
import type { ScreenProps } from "../../navigation/routes";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsNote } from "../settings/components/SettingsNote";
import { SettingsSection } from "../settings/components/SettingsSection";
import { errorMessage } from "../settings/integrations";
import { AppPage, AppStateBody, MonoBlock } from "./app-rows";
import { jsonText, parseOperationInput } from "./apps";
import { useAppHostCall, useAppState } from "./use-app";

/** How one run from the form ended. */
type RunResult = { readonly kind: "value"; readonly text: string } | { readonly kind: "error"; readonly message: string };

/**
 * One operation of an app (docs/plans/apps.md §9.2): what it does to the
 * app's data, what it takes and answers as fields, and a form to run it. An
 * operation that takes nothing runs with one press. The run is a call of the
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
  const inputFields = operationFields(operation.input);
  const outputFields = operation.output ? operationFields(operation.output) : [];
  const takesInput = inputFields === null || inputFields.length > 0;
  const [input, setInput] = useState(() => (takesInput ? operationInputTemplate(operation.input) : ""));
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [showsSchemas, setShowsSchemas] = useState(false);

  const run = () => {
    const parsed = parseOperationInput(takesInput ? input : "");
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
            icon={operation.kind === "query" ? "doc.text" : "square.and.pencil"}
            label={operationKindLabel(operation.kind)}
            description={operation.kind === "query" ? "It reads the app's data and never changes it." : "It can change the app's data."}
          />
          <ListRowLayout label="Time limit" detail={operationTimeLimitText(operation.timeoutSeconds)} />
        </SettingsSection>
        {operation.description ? <SettingsNote>{operation.description}</SettingsNote> : null}
      </View>

      <Fields title="Takes" fields={inputFields} none="No input." schemaText={jsonText(operation.input)} />
      <Fields
        title="Answers"
        fields={outputFields}
        none={operation.output ? "An empty object." : "Any value: this operation declares no output schema."}
        schemaText={operation.output ? jsonText(operation.output) : ""}
      />

      <View className="gap-3">
        <SettingsSection title="Run">
          {takesInput ? (
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
          ) : null}
          <SettingsActionRow icon="play" label={`Run ${operation.name}`} disabled={!props.connected || running} loading={running} onPress={run} />
        </SettingsSection>
        <SettingsNote>{runNoteText(operation, props.stopped)}</SettingsNote>
        {result?.kind === "error" ? <SettingsNote tone="danger">{result.message}</SettingsNote> : null}
      </View>

      {result?.kind === "value" ? (
        <SettingsSection title="Result">
          <View className="p-4">
            <MonoBlock text={result.text} />
          </View>
        </SettingsSection>
      ) : null}

      {operation.output || takesInput ? (
        <SettingsSection title="JSON schemas">
          <ListRow label={showsSchemas ? "Hide the JSON schemas" : "Show the JSON schemas"} onPress={() => setShowsSchemas((shows) => !shows)} />
          {showsSchemas ? (
            <View className="gap-3 p-4">
              <MonoBlock text={jsonText(operation.input)} />
              {operation.output ? <MonoBlock text={jsonText(operation.output)} /> : null}
            </View>
          ) : null}
        </SettingsSection>
      ) : null}
    </>
  );
}

/** The line under Run: why the host refuses the run, or what the run does. */
function runNoteText(operation: AppOperation, stopped: boolean): string {
  if (stopped) return "This app is stopped: the host refuses the run until you start the app.";
  return operation.kind === "mutation"
    ? "This changes the app's data, as a call from its UI does. The call log keeps the run."
    : "This only reads. The call log keeps the run.";
}

/** What an operation takes or answers: a row for each field, or its JSON when the page cannot name its shape. */
function Fields(props: { readonly title: string; readonly fields: OperationField[] | null; readonly none: string; readonly schemaText: string }) {
  return (
    <SettingsSection title={props.title}>
      {props.fields === null ? (
        <View className="p-4">
          <MonoBlock text={props.schemaText} />
        </View>
      ) : props.fields.length === 0 ? (
        <View className="p-4">
          <SettingsNote>{props.none}</SettingsNote>
        </View>
      ) : (
        props.fields.map((field) => (
          <ListRowLayout
            key={field.name}
            label={field.name}
            description={[`${field.type}${field.required ? "" : ", optional"}`, field.description].filter(Boolean).join(" · ")}
          />
        ))
      )}
    </SettingsSection>
  );
}
