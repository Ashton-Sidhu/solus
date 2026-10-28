import { ActivityIndicator, ScrollView as HorizontalScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { cn } from "../../lib/cn";
import { SettingsNote } from "../settings/components/SettingsNote";
import { SettingsSection } from "../settings/components/SettingsSection";
import { useOrganizationWebhooks } from "./use-organization-webhooks";
import { ADMIN_EMPTY_TEXT, ADMIN_FAILED_TEXT, adminWebhookRow, type AdminWebhookRow } from "./webhook-admin";
import { ChoiceChip, PillButton } from "./webhook-rows";

/**
 * The Organization view of the Webhooks screen (docs/plans/webhooks.md §2.7, §4):
 * the organization webhooks of all members, with Pause and Resume for an
 * organization admin. Admins cannot edit a webhook or read its secrets, so a
 * row opens nothing.
 */
export function OrganizationWebhooks() {
  const { workspaces, organizationId, state, busyKey, rowErrors, reload, act, select } = useOrganizationWebhooks();
  const now = Date.now();

  return (
    <View className="gap-3">
      {workspaces.length > 1 ? (
        <HorizontalScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2">
          {workspaces.map((workspace) => (
            <ChoiceChip
              role="button"
              key={workspace.organizationId}
              label={workspace.label}
              accessibilityLabel={`Organization ${workspace.label}`}
              selected={workspace.organizationId === organizationId}
              onPress={() => select(workspace.organizationId)}
            />
          ))}
        </HorizontalScrollView>
      ) : null}

      {organizationId === null ? (
        <SettingsNote>Choose an organization to see its webhooks.</SettingsNote>
      ) : state.kind === "loading" ? (
        <View className="items-center py-2">
          <ActivityIndicator accessibilityLabel="Reading organization webhooks" colorClassName="accent-icon-muted" />
        </View>
      ) : state.kind === "refused" ? (
        <SettingsNote tone="danger">{state.message}</SettingsNote>
      ) : state.kind === "failed" ? (
        <View className="gap-3">
          <ErrorBanner message={ADMIN_FAILED_TEXT} />
          <PillButton label="Retry" onPress={reload} />
        </View>
      ) : state.webhooks.length === 0 ? (
        <SettingsNote>{ADMIN_EMPTY_TEXT}</SettingsNote>
      ) : (
        <SettingsSection title="Organization webhooks">
          {state.webhooks.map((entry, index) => {
            const row = adminWebhookRow(entry, organizationId, now);
            return (
              <AdminWebhookListRow
                key={row.key}
                row={row}
                first={index === 0}
                busy={busyKey === row.key}
                disabled={busyKey !== null}
                error={rowErrors.get(row.key) ?? null}
                onAct={() => void act(row)}
              />
            );
          })}
        </SettingsSection>
      )}
    </View>
  );
}

/** One organization webhook: the lines an admin scans, and Pause or Resume. */
function AdminWebhookListRow(props: {
  readonly row: AdminWebhookRow;
  readonly first: boolean;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly error: string | null;
  readonly onAct: () => void;
}) {
  const { row } = props;
  const label = row.control === "pause" ? "Pause" : "Resume";
  return (
    <View
      className={cn("min-h-14 gap-1 bg-grouped-card px-4 py-3", !props.first && "border-t border-border-subtle")}
    >
      <View className="flex-row items-center gap-2">
        <Text className="min-w-0 flex-1 text-base text-foreground" numberOfLines={1}>
          {row.title}
        </Text>
        <Text
          className={cn(
            "shrink-0 text-sm",
            row.stateTone === "danger" ? "text-danger-foreground" : "text-foreground-muted",
          )}
        >
          {row.state}
        </Text>
      </View>
      {row.lines.map((line) => (
        <Text
          key={line.text}
          className={cn("text-sm", line.tone === "danger" ? "text-danger-foreground" : "text-foreground-muted")}
        >
          {line.text}
        </Text>
      ))}
      <View className="flex-row items-center gap-3 pt-1">
        <PillButton label={label} disabled={props.disabled} onPress={props.onAct} />
        {props.busy ? <ActivityIndicator accessibilityLabel={`${label} in progress`} colorClassName="accent-icon-muted" /> : null}
      </View>
      {props.error ? (
        <Text selectable className="text-sm text-danger-foreground">
          {props.error}
        </Text>
      ) : null}
    </View>
  );
}
