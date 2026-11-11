import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { replaceVoiceTerm } from "@solus/contracts/voice-dictionary";
import type { ScreenProps } from "../../navigation/routes";
import { SymbolView } from "../../components/AppSymbol";
import { AppText } from "../../components/AppText";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsNote } from "./components/SettingsNote";
import { useVoiceDictionary } from "./use-voice-dictionary";

export function VoiceTermScreen({ navigation, route }: ScreenProps<"VoiceTerm">) {
  const { term } = route.params;
  const { entries, error, commit, clearError } = useVoiceDictionary();
  const [termText, setTermText] = useState(term);
  const [aliasText, setAliasText] = useState("");
  const entry = entries.find((item) => item.term === term);

  if (!entry) {
    return (
      <SettingsScreen title="Term">
        <ScreenScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-4 px-5 pt-4 pb-12">
          <SettingsNote>This term is no longer in your dictionary.</SettingsNote>
        </ScreenScrollView>
      </SettingsScreen>
    );
  }
  const { aliases } = entry;

  function rename() {
    const nextTerm = termText.trim();
    if (nextTerm === term) return;
    if (commit((current) => replaceVoiceTerm(current, term, { term: nextTerm, aliases }))) navigation.setParams({ term: nextTerm });
  }

  function addAlias() {
    if (!aliasText.trim()) return;
    if (commit((current) => replaceVoiceTerm(current, term, { term, aliases: [...aliases, aliasText] }))) setAliasText("");
  }

  return (
    <SettingsScreen title="Term">
      <ScreenScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerClassName="gap-4 px-5 pt-4 pb-12">
        <SettingsSection title="Term">
          <View className="p-4">
            <TextInput
              accessibilityLabel="Term"
              value={termText}
              onChangeText={(value) => { setTermText(value); clearError(); }}
              onEndEditing={rename}
              returnKeyType="done"
              autoCapitalize="none"
              autoCorrect={false}
              className="rounded-lg border border-border bg-input p-3 text-base text-foreground"
            />
          </View>
        </SettingsSection>
        <SettingsSection title="Heard as">
          {aliases.map((alias) => (
            <View key={alias} className="flex-row items-center gap-3 p-4">
              <AppText className="flex-1 text-base text-foreground">{alias}</AppText>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove ${alias}`}
                hitSlop={12}
                onPress={() => commit((current) => replaceVoiceTerm(current, term, { term, aliases: aliases.filter((item) => item !== alias) }))}
              >
                <SymbolView name="xmark" size={16} tintColorClassName="accent-icon" type="monochrome" weight="regular" />
              </Pressable>
            </View>
          ))}
          <View className="p-4">
            <TextInput
              accessibilityLabel={`Add what dictation writes for ${term}`}
              value={aliasText}
              onChangeText={(value) => { setAliasText(value); clearError(); }}
              onSubmitEditing={addAlias}
              submitBehavior="submit"
              returnKeyType="done"
              placeholder="Add a phrase"
              autoCapitalize="none"
              autoCorrect={false}
              className="rounded-lg border border-border bg-input p-3 text-base text-foreground"
            />
          </View>
        </SettingsSection>
        {error ? <SettingsNote tone="danger">{error}</SettingsNote> : null}
        <SettingsSection>
          <SettingsActionRow
            icon="trash"
            label="Remove term"
            tone="danger"
            onPress={() => { if (commit((current) => current.filter((item) => item.term !== term))) navigation.goBack(); }}
          />
        </SettingsSection>
      </ScreenScrollView>
    </SettingsScreen>
  );
}
