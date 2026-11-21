import { TextInput, View } from "react-native";
import { missingArguments, type ArgumentField, type ArgumentValue } from "@solus/client-core/integration-prompts";

import { AppText as Text } from "../../components/AppText";

/** The argument form of the MCP sheets: one field for each argument of a
 *  prompt, or each value of a resource template (docs/plans/mcp-first-class.md
 *  §10, §11.3). Desktop and web use `PromptArgumentForm`. */
export function McpArgumentFields(props: {
  readonly description?: string;
  readonly fields: readonly ArgumentField[];
  readonly values: readonly ArgumentValue[];
  readonly onChange: (values: ArgumentValue[]) => void;
  /** The person tried to submit: an empty required field says so. */
  readonly showsMissing: boolean;
  readonly editable?: boolean;
  readonly submitKey: "done" | "send";
  readonly onSubmit: () => void;
}) {
  const missing = props.showsMissing ? missingArguments(props.fields, props.values) : [];
  return (
    <View className="gap-4 px-5 pt-2">
      {props.description ? <Text className="text-sm text-foreground-muted">{props.description}</Text> : null}
      {props.fields.map((field, index) => {
        const isMissing = missing.includes(field.name);
        return (
          <View key={field.name} className="gap-1.5">
            <View className="flex-row items-baseline gap-2">
              <Text className="font-mono text-sm text-foreground">{field.name}</Text>
              {field.required ? (
                <Text className={`text-xs ${isMissing ? "text-danger" : "text-foreground-tertiary"}`}>{isMissing ? "Required" : "required"}</Text>
              ) : null}
            </View>
            <TextInput
              accessibilityLabel={field.name}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus={index === 0}
              editable={props.editable}
              onChangeText={(value) => props.onChange(props.values.map((entry) => (entry.name === field.name ? { ...entry, value } : entry)))}
              onSubmitEditing={props.onSubmit}
              placeholder={field.description ?? ""}
              placeholderTextColorClassName="accent-placeholder"
              returnKeyType={index === props.fields.length - 1 ? props.submitKey : "next"}
              className="h-[40px] rounded-xl bg-subtle px-3 font-sans text-base text-foreground"
              value={props.values[index]?.value ?? ""}
            />
          </View>
        );
      })}
    </View>
  );
}
