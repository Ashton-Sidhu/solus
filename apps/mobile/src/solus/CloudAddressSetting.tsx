import { useState } from "react";
import {
  DEFAULT_CLOUD_ORIGIN,
  cloudAddressChangeRefusalText,
} from "@solus/contracts/cloud-address";
import { useListened } from "@solus-mobile/app/app-context";
import { AppText } from "../components/ui/AppText";
import { ConnectionFormField } from "../features/connection/ConnectionFormField";
import { SettingsRow } from "../features/settings/components/SettingsRow";
import { solus } from "./runtime";

/**
 * The Solus Cloud address of this device (docs/solus-cloud-address.md), in the
 * Solus Cloud section of the account page. Signed out, a disclosure opens a
 * field, so the usual sign-in is unchanged. Signed in, one line shows the
 * address and says to sign out to change it. The account session checks and
 * keeps the address.
 */
export function CloudAddressSetting(props: { isSignedIn: boolean; disabled: boolean }) {
  const address = useListened(solus.account.changes, () => solus.account.cloudAddress);
  const [isOpen, setIsOpen] = useState(address.source === "setting");
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = draft ?? address.origin;
  const change = (next: string | null) => {
    const ended = solus.account.setCloudAddress(next);
    if (ended.ok) setDraft(null);
    setError(ended.ok ? null : cloudAddressChangeRefusalText(ended.refusal));
  };
  if (props.isSignedIn) {
    return (
      <AppText className="px-4 py-3 text-foreground-muted">
        Solus Cloud address: {address.origin}. {cloudAddressChangeRefusalText("signed-in")}
      </AppText>
    );
  }
  return (
    <>
      <SettingsRow
        icon="link"
        label="Use a different Solus Cloud address"
        value={address.source === "setting" ? address.origin.replace(/^https?:\/\//, "") : undefined}
        disabled={props.disabled}
        onPress={() => setIsOpen(!isOpen)}
      />
      {isOpen && (
        <>
          <ConnectionFormField
            className="mx-4 my-3"
            label="Solus Cloud address"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="done"
            placeholder={DEFAULT_CLOUD_ORIGIN}
            editable={!props.disabled}
            value={shown}
            onChangeText={(text) => {
              setDraft(text);
              setError(null);
            }}
            onSubmitEditing={() => change(shown)}
          />
          {error && (
            <AppText accessibilityRole="alert" className="px-4 pb-3 text-sm text-danger-foreground">
              {error}
            </AppText>
          )}
          <SettingsRow
            icon="checkmark"
            label="Save"
            disabled={props.disabled || !shown.trim() || shown.trim() === address.origin}
            onPress={() => change(shown)}
          />
          {address.source === "setting" && (
            <SettingsRow
              icon="arrow.clockwise"
              label={`Use ${DEFAULT_CLOUD_ORIGIN.replace("https://", "")}`}
              disabled={props.disabled}
              onPress={() => change(null)}
            />
          )}
        </>
      )}
    </>
  );
}
