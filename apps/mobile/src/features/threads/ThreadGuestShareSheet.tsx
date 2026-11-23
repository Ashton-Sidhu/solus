import { useCallback, useState } from "react";
import { Platform, ScrollView, Share, View } from "react-native";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { cloudShareUrl } from "@solus/contracts/sharing";
import type { HostApi } from "@solus/client-core/host-api";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useGT } from "gt-react-native";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { Button } from "../../components/ui/Button";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useDeadlinePassed } from "../../lib/clock";
import { useHostSettingsRead } from "../../solus/use-host-settings-read";
import { useSettingsAction } from "../../solus/SettingsFeedback";

export function ThreadGuestShareSheet({
  route,
}: StaticScreenProps<{ environmentId: EnvironmentId; threadId: ThreadId }>) {
  const { environmentId, threadId } = route.params;
  const navigation = useNavigation();
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const resource = { kind: "session", id: threadId } as const;
  const read = useCallback(
    async (api: HostApi) => {
      const target = { kind: "session", id: threadId } as const;
      const [list, { origin }] = await Promise.all([
        api.shareGet({ resource: target }),
        api.shareLinkOrigin(target),
      ]);
      return { list, origin };
    },
    [threadId],
  );
  const { api, data, refresh, error } = useHostSettingsRead(environmentId, read, "share.changed");
  const action = useSettingsAction(refresh);
  const link = data?.list.link;
  const expired = useDeadlinePassed(link?.expiresAt ?? null);
  const url =
    data?.origin && link?.secret && !expired
      ? cloudShareUrl(data.origin, resource, link.secret)
      : null;
  const canManage = data?.list.callerRole === "owner" || data?.list.callerRole === "editor";
  const [copiedAtMs, setCopiedAtMs] = useState<number | null>(null);
  const copyEnded = useDeadlinePassed(copiedAtMs === null ? null : copiedAtMs + 1200);
  const copied = copiedAtMs !== null && !copyEnded;
  const copy = async (url: string) => {
    if (!(await tryCopyTextWithHaptic(url, { target: "guest link" }))) {
      Dialog.alert(gt("Could not copy"), gt("Try again."));
      return;
    }
    setCopiedAtMs(Date.now());
  };

  const share = (url: string) => {
    // Android ignores `url`; iOS turns a `message` URL into plain text instead of a link preview.
    Share.share(Platform.OS === "ios" ? { url } : { message: url }).catch((cause: unknown) => {
      console.error("Failed to share guest link.", cause);
      Dialog.alert(gt("Could not share the link"), gt("Copy it instead."));
    });
  };

  return (
    <View className="flex-1 bg-sheet">
      <SheetHeader title={gt("Share with guest")} onClose={() => navigation.goBack()} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
      >
        {error ? (
          <>
            <Text accessibilityRole="alert">{error}</Text>
            <Button label="Retry" onPress={refresh} />
          </>
        ) : !data ? (
          <Text>Loading link…</Text>
        ) : !canManage ? (
          <Text>Only owners and editors can manage this link.</Text>
        ) : (
          <>
            {url ? (
              <>
                <Text selectable>{url}</Text>
                <View className="flex-row gap-3">
                  <View className="flex-1">
                    <Button
                      label={copied ? gt("Copied") : gt("Copy")}
                      icon={copied ? "checkmark" : "doc.on.doc"}
                      fullWidth
                      onPress={() => void copy(url)}
                    />
                  </View>
                  <View className="flex-1">
                    <Button
                      label={gt("Share")}
                      icon="square.and.arrow.up"
                      tone="primary"
                      fullWidth
                      onPress={() => share(url)}
                    />
                  </View>
                </View>
              </>
            ) : (
              <Text>
                {data.origin
                  ? "Anyone with the new link can view this session for 24 hours."
                  : "This host has no address for guest links."}
              </Text>
            )}
            {!url && data.origin && (
              <Button
                label="Create viewer link"
                disabled={action.busy}
                onPress={() =>
                  void action.run(async () => {
                    if (!api) return;
                    await api.shareSetLink({
                      resource,
                      role: "viewer",
                      expiresInMs: 86400000,
                      regenerate: !!link,
                    });
                  })
                }
              />
            )}
            {link && (
              <Button
                label="Stop sharing by link"
                disabled={action.busy}
                onPress={() =>
                  void action.run(async () => {
                    await api?.shareSetLink({ resource, role: null });
                  })
                }
              />
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}
