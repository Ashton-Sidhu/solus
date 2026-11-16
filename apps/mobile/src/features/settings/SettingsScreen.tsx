// Adapted from T3 Code apps/mobile/src/features/settings/SettingsRouteScreen.tsx (MIT, see UPSTREAM.md).
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useMemo, useState, type ComponentProps } from "react";
import { settingMatches } from "@solus/client-core/settings-search";
import { EmptyState } from "../../components/EmptyState";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { sameNameHostAddresses } from "@solus/client-core/host-address";

import { useApp, useListened } from "../../app/app-context";
import type { ScreenProps } from "../../navigation/routes";
import { hostMachineKind } from "../connection/lib/host-machine";
import { ENVIRONMENT_MACHINE_SYMBOLS } from "../../components/EnvironmentMachineSymbol";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsScreen as SettingsScreenFrame } from "./components/SettingsScreen";
import { APPEARANCE_LABELS, SYNC_STATE_LABELS } from "./lib/settings-labels";

/**
 * Settings by owner (plans/018 §7), in T3's settings layout: this device's
 * connections; yours, which follow you to every host and, with sync, every
 * device; the policies that lock them; and each host's own. Personal settings need no
 * host.
 */
export function SettingsScreen(props: ScreenProps<"Settings">) {
  return <SettingsIndex {...props} />;
}

function SettingsIndex({ navigation }: ScreenProps<"Settings">) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const hosts = useListened(app.registry.changes, app.registry.hosts);
  const hostFilterId = hosts.some((host) => host.id === selectedHostId)
    ? selectedHostId
    : null;
  const hostAddresses = useMemo(
    () =>
      sameNameHostAddresses(
        hosts.map((host) => ({
          id: host.id,
          label: host.label,
          url: host.routes[0]?.url ?? "",
        })),
      ),
    [hosts],
  );
  const account = useListened(app.account.changes, () => app.account.view);
  const directory = useListened(
    app.account.changes,
    () => app.account.directory,
  );
  const organizationId = useListened(
    app.account.changes,
    () => app.account.organizationId,
  );
  const appearance = useListened(
    app.appearance.changes,
    app.appearance.current,
  );
  const sync = useListened(app.accountSync.changes, app.accountSync.current);
  const organizationName =
    directory.kind === "loaded"
      ? directory.organizations.find(
          (organization) => organization.organizationId === organizationId,
        )?.name
      : undefined;
  const accountLabel =
    account.kind === "loading"
      ? "Checking"
      : account.kind === "signed-in"
        ? (account.identity.name ?? account.identity.email)
        : "Sign in";

  const sections: Array<{
    title?: string;
    rows: Array<ComponentProps<typeof SettingsRow>>;
  }> = [
    {
      title: "Connections",
      rows: [
        {
          icon: "person.crop.circle",
          label: "Solus Cloud",
          value: accountLabel,
          disabled: account.kind === "loading",
          onPress: () =>
            navigation.navigate(
              account.kind === "signed-in" ? "CloudHosts" : "CloudSignIn",
            ),
        },
        {
          icon: "desktopcomputer",
          label: "Hosts",
          value: String(hosts.length),
          valuePosition: "trailing",
          onPress: () => navigation.navigate("Hosts"),
        },
        {
          icon: "bell.badge",
          label: "Notifications",
          accessibilityHint: "What you are told about, and how",
          onPress: () => navigation.navigate("NotificationSettings"),
        },
        {
          icon: "arrow.clockwise",
          label: "Account & sync",
          value: SYNC_STATE_LABELS[sync.state],
          accessibilityHint: "Your synced settings and agent profile",
          onPress: () => navigation.navigate("AccountSync"),
        },
        {
          icon: { ios: "tray", android: "chat_bubble" },
          label: "Inbox",
          onPress: () => navigation.navigate("Notifications"),
        },
      ],
    },
    {
      rows: [
        {
          icon: "paintbrush",
          label: "Appearance",
          value: APPEARANCE_LABELS[appearance],
          onPress: () => navigation.navigate("AppearanceSettings"),
        },
        {
          icon: "text.bubble",
          label: "Chat",
          accessibilityHint: "Responses, tool calls, and the input bar",
          onPress: () => navigation.navigate("ChatSettings"),
        },
        {
          icon: "mic",
          label: "Voice",
          accessibilityHint: "Your dictation dictionary",
          onPress: () => navigation.navigate("VoiceSettings"),
        },
      ],
    },
    {
      title: "Agents",
      rows: [
        {
          icon: "person.crop.circle",
          label: "Providers",
          accessibilityHint: "Default model and options for each provider",
          onPress: () => navigation.navigate("Providers"),
        },
        {
          icon: "text.bubble",
          label: "Sessions",
          accessibilityHint: "Default provider, permissions, and limits",
          onPress: () => navigation.navigate("AgentDefaults"),
        },
        {
          icon: "doc.text",
          label: "Agent profile",
          accessibilityHint:
            "Your instructions, skills, and MCP servers on every host",
          onPress: () => navigation.navigate("AgentProfile"),
        },
      ],
    },
    ...(hosts.length
      ? ([
          {
            title: "Apps",
            rows: [
              {
                icon: "square.grid.2x2",
                label: "Apps",
                onPress: () => navigation.navigate("Apps"),
              },
            ],
          },
          {
            title: "Policy",
            rows: [
              {
                icon: "lock",
                label: "Policy",
                value: organizationName ?? "Personal",
                onPress: () =>
                  navigation.navigate(
                    "Policy",
                    organizationId ? { organizationId } : undefined,
                  ),
              },
            ],
          },
          {
            title: "Host settings",
            rows: hosts
              .filter(
                (host) =>
                  hostFilterId === null || host.id === hostFilterId,
              )
              .map((host) => ({
                icon: ENVIRONMENT_MACHINE_SYMBOLS[hostMachineKind(host)],
                label: host.label,
                value: hostAddresses.get(host.id),
                valuePosition: "below" as const,
                onPress: () =>
                  navigation.navigate("HostSettings", { hostId: host.id }),
              })),
          },
        ] satisfies Array<{
          title: string;
          rows: Array<ComponentProps<typeof SettingsRow>>;
        }>)
      : []),
    {
      title: "Advanced",
      rows: [
        {
          icon: "info.circle",
          label: "About Solus",
          onPress: () => navigation.navigate("About"),
        },
      ],
    },
  ];
  const visibleSections = sections.flatMap((section) => {
    const rows = section.rows.filter((row) =>
      settingMatches(query, {
        label: row.label,
        description: row.accessibilityHint,
        keywords: [section.title ?? "", row.value ?? ""],
      }),
    );
    return rows.length ? [{ ...section, rows }] : [];
  });
  const history = navigation.getState();
  const workspaceRoot = history.routes[history.index - 1]?.name === "Home";

  return (
    <SettingsScreenFrame
      title="Settings"
      workspaceRoot={workspaceRoot}
      search={{
        value: query,
        onChangeText: setQuery,
        placeholder: "Search settings",
        mode: "inline",
        compactToolbar: false,
      }}
      menus={
        hosts.length
          ? [
              {
                title: "Filter host settings",
                icon: "line.3.horizontal.decrease",
                items: [
                  {
                    id: "all",
                    title: "All hosts",
                    selected: hostFilterId === null,
                    onPress: () => setSelectedHostId(null),
                  },
                  ...hosts.map((host) => ({
                    id: host.id,
                    title: host.label,
                    selected: host.id === hostFilterId,
                    onPress: () => setSelectedHostId(host.id),
                  })),
                ],
              },
            ]
          : undefined
      }
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        {visibleSections.map((section, index) => (
          <SettingsSection
            key={section.title ?? `app-${index}`}
            title={section.title}
          >
            {section.rows.map((row) => (
              <SettingsRow key={row.label} {...row} />
            ))}
          </SettingsSection>
        ))}
        {!visibleSections.length ? (
          <EmptyState
            title="No results"
            detail="Try another settings search."
            variant="plain"
          />
        ) : null}
      </ScrollView>
    </SettingsScreenFrame>
  );
}
