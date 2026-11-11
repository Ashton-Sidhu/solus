import { useState } from "react";
import { TextInput, View } from "react-native";
import { addVoiceTerms, filterVoiceDictionary, VOICE_DICTIONARY_LIMIT } from "@solus/contracts/voice-dictionary";
import type { ScreenProps } from "../../navigation/routes";
import { ListRow } from "../../components/ListRow";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsNote } from "./components/SettingsNote";
import { useVoiceDictionary } from "./use-voice-dictionary";

export function VoiceSettingsScreen({ navigation }: ScreenProps<"VoiceSettings">) {
  const { entries, error, commit, clearError } = useVoiceDictionary();
  const [addText, setAddText] = useState("");
  const [query, setQuery] = useState("");
  const visible = filterVoiceDictionary(entries, query);

  function add() {
    if (!addText.trim() || !commit((current) => addVoiceTerms(current, addText))) return;
    setAddText("");
    setQuery("");
  }

  return (
    <SettingsScreen title="Voice">
      <ScreenScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerClassName="gap-4 px-5 pt-4 pb-12">
        <SettingsNote>Mobile dictation uses your keyboard. This dictionary applies to desktop and web dictation. It follows settings sync.</SettingsNote>
        <SettingsSection title="Custom dictionary">
          <View className="p-4">
            <TextInput
              accessibilityLabel="Add terms"
              value={addText}
              onChangeText={(value) => { setAddText(value); clearError(); }}
              onSubmitEditing={add}
              submitBehavior="submit"
              returnKeyType="done"
              placeholder="Add a term, or paste a list with one term per line"
              multiline
              maxLength={80_000}
              autoCapitalize="none"
              autoCorrect={false}
              className="rounded-lg border border-border bg-input p-3 text-base text-foreground"
            />
          </View>
          <SettingsActionRow icon="plus" label="Add" disabled={!addText.trim()} onPress={add} />
        </SettingsSection>
        {error ? <SettingsNote tone="danger">{error}</SettingsNote> : null}
        {entries.length ? (
          <TextInput
            accessibilityLabel="Filter terms"
            value={query}
            onChangeText={setQuery}
            placeholder="Filter terms"
            autoCapitalize="none"
            autoCorrect={false}
            className="rounded-lg border border-border bg-input p-3 text-base text-foreground"
          />
        ) : null}
        {visible.length ? (
          <SettingsSection title="Terms">
            {visible.map(({ term, aliases }) => (
              <ListRow
                key={term}
                label={term}
                description={aliases.length ? aliases.join(", ") : undefined}
                accessibilityHint="Edit this term"
                onPress={() => navigation.navigate("VoiceTerm", { term })}
              />
            ))}
          </SettingsSection>
        ) : (
          <SettingsNote>{entries.length ? "No terms match your filter." : "No terms yet."}</SettingsNote>
        )}
        <SettingsNote>{`${entries.length} of ${VOICE_DICTIONARY_LIMIT} terms. Changes save at once and apply to the next desktop or web recording.`}</SettingsNote>
      </ScreenScrollView>
    </SettingsScreen>
  );
}
