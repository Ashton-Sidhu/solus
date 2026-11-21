import { View } from "react-native";
import { missingArguments, type ArgumentField, type ArgumentValue } from "@solus/client-core/integration-prompts";

import { AppText as Text } from "../../components/AppText";
import { FormField } from "../../components/FormControls";

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
      {props.fields.map((field, index) => (
        <FormField
          key={field.name}
          label={field.name}
          required={field.required}
          missing={missing.includes(field.name)}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus={index === 0}
          editable={props.editable}
          onChangeText={(value) => props.onChange(props.values.map((entry) => (entry.name === field.name ? { ...entry, value } : entry)))}
          onSubmitEditing={props.onSubmit}
          placeholder={field.description ?? ""}
          placeholderTextColorClassName="accent-placeholder"
          returnKeyType={index === props.fields.length - 1 ? props.submitKey : "next"}
          value={props.values[index]?.value ?? ""}
        />
      ))}
    </View>
  );
}
