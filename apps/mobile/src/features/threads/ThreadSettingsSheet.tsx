// Adapted from T3 Code apps/mobile/src/features/threads/ThreadSettingsSheet.tsx and
// ThreadSettingsRows.shared.tsx (MIT, see UPSTREAM.md).
import type { AgentId, PermissionMode, ReasoningEffort } from "@solus/contracts/types";
import type { LegendListRenderItemProps } from "@legendapp/list/react-native";
import { AnimatedLegendList } from "@legendapp/list/reanimated";
import {
  NavigationContainer,
  NavigationIndependentTree,
  useNavigation,
  useRoute,
  type RouteProp,
} from "@react-navigation/native";
import {
  createNativeStackNavigator,
  type NativeStackNavigationProp,
} from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { createContext, use, useCallback, useMemo, useState, type ReactNode } from "react";
import { Modal, Platform, ScrollView, TextInput, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { MaterialButton } from "../../components/MaterialButton";
import { MaterialIconButton } from "../../components/MaterialIconButton";
import { MaterialScreenContent } from "../../components/MaterialScreenContent";
import { MOBILE_FONTS } from "../../lib/typography";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { NativeHeaderToolbar, NativeStackScreenOptions, nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  ProviderHeader,
  DisclosureRow,
  FastModeRow,
  AutoRow,
  ModelRow,
  ChoiceRow,
} from "./ThreadSettingsRows";
import type { ConversationMeta, ConversationStore } from "../conversation/conversation-store";
import { AUTO_MODEL_ID } from "@solus/contracts/model-routing";
import {
  canChoosePermissionMode,
  effortLabel,
  PERMISSION_MODE_ICON,
  supportsFastMode,
  type AgentCapabilities,
} from "../conversation/lib/run-settings";
import {
  autoModelOption,
  buildProviderGroups,
  modelMatchesCatalogQuery,
  pendingModelAfterPress,
  type PermissionModeChoice,
  providerSectionIsCollapsed,
  permissionModeChoices,
  selectableEffortChoices,
  type ModelOption,
  type ProviderGroup,
} from "./thread-settings-options";

const THREAD_SETTINGS_MAINTAIN_VISIBLE_CONTENT_POSITION = {
  data: false,
  size: true,
} as const;
const THREAD_SETTINGS_CATALOG_LAYOUT_TRANSITION = LinearTransition.duration(180);
const THREAD_SETTINGS_CATALOG_ENTER_TRANSITION = FadeIn.duration(140);
const THREAD_SETTINGS_CATALOG_EXIT_TRANSITION = FadeOut.duration(120);
const THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION = LinearTransition.duration(180);
const THREAD_SETTINGS_HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(
  Platform.OS,
  Platform.Version,
);

type ThreadSettingsSubmenuPage = { readonly kind: "reasoning" } | { readonly kind: "permission" };

/** What one settings presentation edits: the applied model, its reasoning, and the permission mode. */
export interface ThreadSettingsSessionProps {
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  readonly selectedProvider: AgentId;
  readonly selectedModel: string | null;
  readonly reasoningEffort: ReasoningEffort;
  readonly fastMode: boolean;
  readonly permissionMode: PermissionMode;
  /** What the session's agent reports it can do; unknown allows every mode. */
  readonly capabilities: AgentCapabilities;
  /** Auto is offered only before the host starts the session. */
  readonly canRoute: boolean;
  readonly autoNeedsKey: boolean;
  /** Applies a model and the reasoning and fast mode chosen with it. */
  readonly onSelectModel: (option: ModelOption, effort: ReasoningEffort | null, fastMode: boolean | null) => void;
  readonly onUpdateReasoningEffort: (effort: ReasoningEffort) => void;
  readonly onUpdateFastMode: (fastMode: boolean) => void;
  readonly onUpdatePermissionMode: (mode: PermissionMode) => void;
}

function stagedPickIsOffered(option: ModelOption, props: ThreadSettingsSessionProps): boolean {
  if (option.model === AUTO_MODEL_ID) return props.canRoute && !props.autoNeedsKey;
  return props.providerGroups.some(
    (group) => group.providerKey === option.provider && !group.unavailableReason,
  );
}

type ThreadSettingsSessionValue = {
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  /** Auto as a pick, when this session can still take it. */
  readonly autoOption: ModelOption | null;
  readonly autoNeedsKey: boolean;
  readonly permissionMode: PermissionMode;
  readonly permissionChoices: ReadonlyArray<PermissionModeChoice>;
  readonly canChoosePermission: boolean;
  readonly onUpdatePermissionMode: (mode: PermissionMode) => void;
  /** The model the options rows describe: the staged pick, else the applied one. */
  readonly displayedProvider: AgentId;
  readonly displayedModel: string | null;
  readonly displayedEffort: ReasoningEffort;
  readonly displayedFastMode: boolean;
  readonly providerExpansionOverrides: ReadonlySet<string>;
  readonly hasLegacyModels: boolean;
  readonly pendingModel: ModelOption | null;
  readonly searchQuery: string;
  readonly showLegacy: boolean;
  readonly applyEffort: (effort: ReasoningEffort) => void;
  readonly applyFastMode: (fastMode: boolean) => void;
  readonly commitPendingModel: () => void;
  readonly isApplied: (option: ModelOption) => boolean;
  readonly isDisplayed: (option: ModelOption) => boolean;
  readonly pressModel: (option: ModelOption) => void;
  readonly setSearchQuery: (query: string) => void;
  readonly setShowLegacy: (showLegacy: boolean) => void;
  readonly toggleProvider: (providerKey: string) => void;
};

const ThreadSettingsSessionContext = createContext<ThreadSettingsSessionValue | null>(null);

/** Owns the staged model and option state for one picker presentation. */
function ThreadSettingsSessionProvider(
  props: ThreadSettingsSessionProps & { readonly children: ReactNode },
) {
  const [showLegacy, setShowLegacy] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [providerExpansionOverrides, setProviderExpansionOverrides] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [stagedModel, setPendingModel] = useState<ModelOption | null>(null);
  // A staged pick the host no longer offers is not kept: an agent it reports
  // unavailable, or Auto once the session started or the key is gone.
  const pendingModel = stagedModel && stagedPickIsOffered(stagedModel, props) ? stagedModel : null;
  const [pendingEffort, setPendingEffort] = useState<ReasoningEffort | null>(null);
  const [pendingFastMode, setPendingFastMode] = useState<boolean | null>(null);

  const isApplied = useCallback(
    (option: ModelOption) =>
      option.provider === props.selectedProvider && option.model === props.selectedModel,
    [props.selectedModel, props.selectedProvider],
  );
  // The list highlights the staged pick; Save turns it into the applied one.
  const isDisplayed = useCallback(
    (option: ModelOption) => (pendingModel ? option.key === pendingModel.key : isApplied(option)),
    [isApplied, pendingModel],
  );
  const displayedProvider = pendingModel?.provider ?? props.selectedProvider;
  const displayedModel = pendingModel?.model ?? props.selectedModel;
  const displayedEffort = pendingModel
    ? (pendingEffort ?? selectableEffortChoices(pendingModel.provider, pendingModel.model)[0] ?? props.reasoningEffort)
    : props.reasoningEffort;
  const displayedFastMode = pendingModel ? (pendingFastMode ?? false) : props.fastMode;
  const autoOption = useMemo(
    () => (props.canRoute ? autoModelOption(props.selectedProvider) : null),
    [props.canRoute, props.selectedProvider],
  );
  const permissionChoices = useMemo(() => permissionModeChoices(props.capabilities), [props.capabilities]);

  const hasLegacyModels = useMemo(
    () => props.providerGroups.some((group) => group.models.some((model) => model.isLegacy)),
    [props.providerGroups],
  );
  const commitPendingModel = useCallback(() => {
    if (!pendingModel) return;
    void Haptics.selectionAsync();
    props.onSelectModel(pendingModel, pendingEffort, pendingFastMode);
  }, [pendingEffort, pendingFastMode, pendingModel, props.onSelectModel]);

  // While a model is staged, the reasoning row edits the staged choice; Save
  // applies model and reasoning together. Otherwise it edits the applied run.
  const applyEffort = useCallback(
    (effort: ReasoningEffort) => {
      if (pendingModel) setPendingEffort(effort);
      else props.onUpdateReasoningEffort(effort);
    },
    [pendingModel, props.onUpdateReasoningEffort],
  );
  const applyFastMode = useCallback(
    (fastMode: boolean) => {
      if (pendingModel) setPendingFastMode(fastMode);
      else props.onUpdateFastMode(fastMode);
    },
    [pendingModel, props.onUpdateFastMode],
  );

  const toggleProvider = useCallback((providerKey: string) => {
    setProviderExpansionOverrides((current) => {
      const next = new Set(current);
      if (!next.delete(providerKey)) {
        next.add(providerKey);
      }
      return next;
    });
  }, []);

  const pressModel = useCallback(
    (option: ModelOption) => {
      void Haptics.selectionAsync();
      setPendingEffort(null);
      setPendingFastMode(null);
      setPendingModel((current) =>
        pendingModelAfterPress({ current, pressed: option, pressedIsApplied: isApplied(option) }),
      );
    },
    [isApplied],
  );

  const value = useMemo<ThreadSettingsSessionValue>(
    () => ({
      providerGroups: props.providerGroups,
      autoOption,
      autoNeedsKey: props.autoNeedsKey,
      permissionMode: props.permissionMode,
      permissionChoices,
      canChoosePermission: canChoosePermissionMode(props.capabilities),
      onUpdatePermissionMode: props.onUpdatePermissionMode,
      displayedProvider,
      displayedModel,
      displayedEffort,
      displayedFastMode,
      providerExpansionOverrides,
      hasLegacyModels,
      pendingModel,
      searchQuery,
      showLegacy,
      applyEffort,
      applyFastMode,
      commitPendingModel,
      isApplied,
      isDisplayed,
      pressModel,
      setSearchQuery,
      setShowLegacy,
      toggleProvider,
    }),
    [
      applyEffort,
      applyFastMode,
      autoOption,
      commitPendingModel,
      displayedEffort,
      displayedFastMode,
      displayedModel,
      displayedProvider,
      hasLegacyModels,
      isApplied,
      isDisplayed,
      pendingModel,
      pressModel,
      providerExpansionOverrides,
      permissionChoices,
      props.autoNeedsKey,
      props.capabilities,
      props.onUpdatePermissionMode,
      props.providerGroups,
      props.permissionMode,
      searchQuery,
      showLegacy,
      toggleProvider,
    ],
  );

  return (
    <ThreadSettingsSessionContext.Provider value={value}>
      {props.children}
    </ThreadSettingsSessionContext.Provider>
  );
}

function useThreadSettingsSession() {
  const value = use(ThreadSettingsSessionContext);
  if (!value) {
    throw new Error("useThreadSettingsSession must be used inside ThreadSettingsSessionProvider.");
  }
  return value;
}

type ThreadSettingsCatalogItem =
  | {
      readonly kind: "provider";
      readonly key: string;
      readonly group: ProviderGroup;
      readonly collapsible: boolean;
      readonly collapsed: boolean;
      readonly modelCount: number;
    }
  | {
      readonly kind: "model";
      readonly key: string;
      readonly option: ModelOption;
      readonly isFirst: boolean;
      readonly isLast: boolean;
    }
  | { readonly kind: "auto"; readonly key: "auto"; readonly option: ModelOption }
  | { readonly kind: "empty"; readonly key: "empty" }
  | { readonly kind: "options"; readonly key: "options" };

function useThreadSettingsCatalogItems(
  session: ThreadSettingsSessionValue,
): ReadonlyArray<ThreadSettingsCatalogItem> {
  return useMemo(() => {
    const auto = session.autoOption;
    const autoItems =
      auto && modelMatchesCatalogQuery({ model: auto, query: session.searchQuery })
        ? [{ kind: "auto" as const, key: "auto" as const, option: auto }]
        : [];
    const groupItems = session.providerGroups.flatMap((group) => {
        const catalogModels = session.showLegacy
          ? group.models
          : group.models.filter((model) => !model.isLegacy || session.isDisplayed(model));
        const visibleModels = catalogModels.filter((model) =>
          modelMatchesCatalogQuery({ model, query: session.searchQuery }),
        );
        if (visibleModels.length === 0) {
          return [];
        }
        const isNarrowed = session.searchQuery.trim().length > 0;
        if (group.unavailableReason) {
          return [
            {
              kind: "provider" as const,
              key: `provider:${group.providerKey}`,
              group,
              collapsible: false,
              collapsed: true,
              modelCount: visibleModels.length,
            },
          ];
        }
        const collapsed = providerSectionIsCollapsed({
          // Claude Code and Codex are the everyday agents: both start open.
          defaultExpanded: true,
          hasExpansionOverride: session.providerExpansionOverrides.has(group.providerKey),
          isNarrowed,
        });
        const models = collapsed ? [] : visibleModels;
        return [
          {
            kind: "provider" as const,
            key: `provider:${group.providerKey}`,
            group,
            collapsible: !isNarrowed,
            collapsed,
            modelCount: visibleModels.length,
          },
          ...models.map((option, index) => ({
            kind: "model" as const,
            key: `model:${option.key}`,
            option,
            isFirst: index === 0,
            isLast: index === models.length - 1,
          })),
        ];
      });
    return [...autoItems, ...groupItems];
  }, [
      session.autoOption,
      session.isDisplayed,
      session.providerExpansionOverrides,
      session.providerGroups,
      session.searchQuery,
      session.showLegacy,
    ]);
}

function ThreadSettingsOptionsItem(props: {
  readonly onOpenSubmenu: (submenu: ThreadSettingsSubmenuPage) => void;
}) {
  const insets = useSafeAreaInsets();
  const session = useThreadSettingsSession();
  const isAuto = session.displayedModel === AUTO_MODEL_ID;
  // Auto routes with fixed options, so the levels belong to the model it picks.
  const effortChoices = isAuto ? [] : selectableEffortChoices(session.displayedProvider, session.displayedModel);
  const offersFastMode = supportsFastMode(session.displayedProvider, session.displayedModel);
  const displayedLabel = session.providerGroups
    .flatMap((group) => group.models)
    .find((model) => model.provider === session.displayedProvider && model.model === session.displayedModel)?.label;

  return (
    <View style={{ paddingBottom: insets.bottom + 12 }}>
      <Text className="px-5 pb-2 pt-6 text-sm font-t3-medium text-foreground-muted">Options</Text>
      <Animated.View
        className="mx-4 overflow-hidden rounded-2xl bg-grouped-card"
        layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}
      >
        {effortChoices.length > 1 ? (
          <DisclosureRow
            label="Reasoning"
            value={effortLabel(session.displayedEffort)}
            onPress={() => props.onOpenSubmenu({ kind: "reasoning" })}
          />
        ) : null}
        <Animated.View layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}>
          <DisclosureRow
            isLast={!offersFastMode}
            accessibilityHint={session.canChoosePermission ? undefined : "This agent runs without permission modes"}
            disabled={!session.canChoosePermission}
            label="Permission mode"
            value={session.permissionChoices.find((choice) => choice.mode === session.permissionMode)?.label}
            valueIcon={PERMISSION_MODE_ICON[session.permissionMode]}
            onPress={() => props.onOpenSubmenu({ kind: "permission" })}
          />
        </Animated.View>
        {offersFastMode ? (
          <FastModeRow
            modelLabel={displayedLabel ?? "this model"}
            value={session.displayedFastMode}
            onValueChange={(value) => {
              void Haptics.selectionAsync();
              session.applyFastMode(value);
            }}
          />
        ) : null}
      </Animated.View>
      <Text className="px-5 pt-2 text-xs text-foreground-muted">
        Changes apply to the next message.
      </Text>
    </View>
  );
}

/** One native scroll owner for the model catalog and its related settings. */
function ThreadSettingsMainContent(props: {
  readonly onOpenSubmenu: (submenu: ThreadSettingsSubmenuPage) => void;
}) {
  const session = useThreadSettingsSession();
  const catalogItems = useThreadSettingsCatalogItems(session);
  const [animationsReady, setAnimationsReady] = useState(false);
  const hasActiveCatalogFilter = session.searchQuery.trim().length > 0;
  const listItems = useMemo<ReadonlyArray<ThreadSettingsCatalogItem>>(
    () => [
      ...(catalogItems.length === 0 ? ([{ kind: "empty", key: "empty" }] as const) : catalogItems),
      { kind: "options", key: "options" },
    ],
    [catalogItems],
  );
  const renderCatalogItem = useCallback(
    (itemProps: LegendListRenderItemProps<ThreadSettingsCatalogItem>) => {
      const item = itemProps.item;
      let content: ReactNode;

      if (item.kind === "provider") {
        content = (
          <ProviderHeader
            collapsible={item.collapsible}
            collapsed={item.collapsed}
            driver={item.group.providerKey}
            label={item.group.providerLabel}
            unavailableReason={item.group.unavailableReason}
            modelCount={item.modelCount}
            onToggle={() => session.toggleProvider(item.group.providerKey)}
          />
        );
      } else if (item.kind === "model") {
        content = (
          <ModelRow
            isFirst={item.isFirst}
            isLast={item.isLast}
            option={item.option}
            selected={session.isDisplayed(item.option)}
            onPress={() => session.pressModel(item.option)}
          />
        );
      } else if (item.kind === "auto") {
        content = (
          <AutoRow
            needsKey={session.autoNeedsKey}
            selected={session.isDisplayed(item.option)}
            onPress={() => session.pressModel(item.option)}
          />
        );
      } else if (item.kind === "empty") {
        content = (
          <View className="items-center px-8 py-14">
            <Text className="text-center text-sm text-foreground-muted">
              {hasActiveCatalogFilter ? "No matching models" : "No available models"}
            </Text>
          </View>
        );
      } else {
        content = <ThreadSettingsOptionsItem onOpenSubmenu={props.onOpenSubmenu} />;
      }

      return (
        <Animated.View
          key={item.key}
          entering={animationsReady ? THREAD_SETTINGS_CATALOG_ENTER_TRANSITION : undefined}
          exiting={animationsReady ? THREAD_SETTINGS_CATALOG_EXIT_TRANSITION : undefined}
        >
          {content}
        </Animated.View>
      );
    },
    [animationsReady, hasActiveCatalogFilter, props.onOpenSubmenu, session],
  );

  return (
    <AnimatedLegendList
      alwaysBounceVertical
      automaticallyAdjustsScrollIndicatorInsets
      className="flex-1 bg-sheet"
      style={
        Platform.OS === "android"
          ? { width: "100%", maxWidth: 720, alignSelf: "center" }
          : undefined
      }
      contentContainerStyle={{ paddingTop: 4 }}
      contentInsetAdjustmentBehavior="automatic"
      data={listItems}
      estimatedItemSize={Platform.OS === "android" ? 56 : 48}
      extraData={session}
      getItemType={(item) => item.kind}
      itemLayoutAnimation={THREAD_SETTINGS_CATALOG_LAYOUT_TRANSITION}
      keyExtractor={(item) => item.key}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      maintainVisibleContentPosition={THREAD_SETTINGS_MAINTAIN_VISIBLE_CONTENT_POSITION}
      ListHeaderComponent={
        Platform.OS === "android" ? (
          <View className="px-4 pb-2 pt-3">
            <View
              className="flex-row items-center rounded-full bg-input px-2"
              style={{ minHeight: 56 }}
            >
              <View pointerEvents="none" className="px-2">
                <SymbolView
                  name="magnifyingglass"
                  size={24}
                  tintColorClassName="accent-icon-subtle"
                />
              </View>
              <TextInput
                accessibilityLabel="Find a model"
                autoCapitalize="none"
                autoCorrect={false}
                className="min-w-0 flex-1 px-2 py-0 text-base text-foreground"
                style={{ minHeight: 56, includeFontPadding: false, textAlignVertical: "center" }}
                onChangeText={session.setSearchQuery}
                placeholder="Find a model"
                placeholderTextColorClassName="accent-placeholder"
                selectionColorClassName="accent-focus/32"
                cursorColorClassName="accent-focus"
                selectionHandleColorClassName="accent-focus"
                value={session.searchQuery}
              />
              {session.searchQuery.length > 0 ? (
                <MaterialIconButton
                  accessibilityLabel="Clear model search"
                  icon="xmark"
                  onPress={() => session.setSearchQuery("")}
                />
              ) : null}
            </View>
          </View>
        ) : null
      }
      recycleItems
      onLoad={() => setAnimationsReady(true)}
      renderItem={renderCatalogItem}
      showsVerticalScrollIndicator={false}
    />
  );
}

/** Compact choice page pushed by the picker navigator. */
function ThreadSettingsChoiceContent(props: {
  readonly submenu: ThreadSettingsSubmenuPage;
  readonly onSelected: () => void;
}) {
  const insets = useSafeAreaInsets();
  const session = useThreadSettingsSession();

  const rows =
    props.submenu.kind === "permission"
      ? session.permissionChoices.map((choice) => ({
          id: choice.mode,
          label: choice.label,
          description: choice.description,
          icon: PERMISSION_MODE_ICON[choice.mode],
          selected: choice.mode === session.permissionMode,
          onPress: () => {
            void Haptics.selectionAsync();
            session.onUpdatePermissionMode(choice.mode);
            props.onSelected();
          },
        }))
      : selectableEffortChoices(session.displayedProvider, session.displayedModel).map((effort) => ({
          id: effort,
          label: effortLabel(effort),
          description: undefined,
          icon: undefined,
          selected: effort === session.displayedEffort,
          onPress: () => {
            void Haptics.selectionAsync();
            session.applyEffort(effort);
            props.onSelected();
          },
        }));

  return (
    <ScrollView
      className="flex-1 bg-sheet"
      style={
        Platform.OS === "android"
          ? { width: "100%", maxWidth: 720, alignSelf: "center" }
          : undefined
      }
      contentContainerStyle={{
        paddingBottom: insets.bottom + 12,
        paddingHorizontal: 16,
        paddingTop: 16,
      }}
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
    >
      <View className="overflow-hidden rounded-2xl bg-grouped-card">
        {rows.map((row, index) => (
          <ChoiceRow
            key={row.id}
            description={row.description}
            icon={row.icon}
            isLast={index === rows.length - 1}
            label={row.label}
            selected={row.selected}
            onPress={row.onPress}
          />
        ))}
      </View>
    </ScrollView>
  );
}

type ThreadSettingsPickerStackParams = {
  ThreadSettingsModels: undefined;
  ThreadSettingsChoice: ThreadSettingsSubmenuPage & { readonly title: string };
};

const ThreadSettingsPickerStack = createNativeStackNavigator<ThreadSettingsPickerStackParams>();
const ThreadSettingsPickerPresentationContext = createContext<{ readonly onClose: () => void } | null>(
  null,
);

function useThreadSettingsPickerPresentation() {
  const value = use(ThreadSettingsPickerPresentationContext);
  if (!value) {
    throw new Error(
      "useThreadSettingsPickerPresentation must be used inside ThreadSettingsPickerNavigator.",
    );
  }
  return value;
}

function ThreadSettingsModelsScreen() {
  const session = useThreadSettingsSession();
  const presentation = useThreadSettingsPickerPresentation();
  const navigation = useNavigation<NativeStackNavigationProp<ThreadSettingsPickerStackParams>>();
  const commitAndClose = useCallback(() => {
    session.commitPendingModel();
    presentation.onClose();
  }, [presentation, session]);

  return (
    <>
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          trailing={
            <View className="flex-row items-center">
              {session.hasLegacyModels ? (
                <MaterialIconButton
                  accessibilityLabel={session.showLegacy ? "Hide legacy models" : "Show legacy models"}
                  icon="line.3.horizontal.decrease"
                  selected={session.showLegacy}
                  variant={session.showLegacy ? "tonal" : "standard"}
                  onPress={() => session.setShowLegacy(!session.showLegacy)}
                />
              ) : null}
              {session.pendingModel ? (
                <MaterialButton label="Save" tone="text" onPress={commitAndClose} />
              ) : null}
            </View>
          }
          onBack={presentation.onClose}
          title="Session settings"
          hideBottomBorder
        />
      ) : null}
      <NativeStackScreenOptions
        optionsVersion={[session.showLegacy, session.hasLegacyModels]}
        options={{
          headerShown: Platform.OS !== "android",
          headerSearchBarOptions:
            Platform.OS === "ios"
              ? {
                  autoCapitalize: "none",
                  hideNavigationBar: false,
                  obscureBackground: false,
                  onCancelButtonPress: () => session.setSearchQuery(""),
                  onChangeText: (event) => session.setSearchQuery(event.nativeEvent.text),
                  placeholder: "Find a model",
                }
              : undefined,
        }}
      />
      <MaterialScreenContent>
        <ThreadSettingsMainContent
          onOpenSubmenu={(submenu) =>
            navigation.navigate("ThreadSettingsChoice", {
              ...submenu,
              title: submenu.kind === "permission" ? "Permission mode" : "Reasoning",
            })
          }
        />
      </MaterialScreenContent>
      <NativeHeaderToolbar placement="left">
        <NativeHeaderToolbar.Button
          accessibilityLabel="Cancel session settings"
          label="Cancel"
          onPress={presentation.onClose}
        />
      </NativeHeaderToolbar>
      <NativeHeaderToolbar placement="right">
        <NativeHeaderToolbar.Button
          accessibilityLabel={session.pendingModel ? "Save session settings" : "Done"}
          label={session.pendingModel ? "Save" : "Done"}
          onPress={commitAndClose}
        />
      </NativeHeaderToolbar>
      {Platform.OS === "ios" && session.hasLegacyModels ? (
        <NativeHeaderToolbar placement="bottom">
          <NativeHeaderToolbar.Menu
            accessibilityLabel="Filter models"
            icon={
              session.showLegacy
                ? "line.3.horizontal.decrease.circle.fill"
                : "line.3.horizontal.decrease.circle"
            }
            separateBackground
            title="Model filters"
          >
            <NativeHeaderToolbar.MenuAction
              isOn={session.showLegacy}
              onPress={() => session.setShowLegacy(!session.showLegacy)}
            >
              Show legacy models
            </NativeHeaderToolbar.MenuAction>
          </NativeHeaderToolbar.Menu>
        </NativeHeaderToolbar>
      ) : null}
    </>
  );
}

function ThreadSettingsChoiceScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<ThreadSettingsPickerStackParams>>();
  const route = useRoute<RouteProp<ThreadSettingsPickerStackParams, "ThreadSettingsChoice">>();

  return (
    <>
      <NativeStackScreenOptions options={{ headerShown: Platform.OS !== "android" }} />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title={route.params.title}
          onBack={() => navigation.goBack()}
          hideBottomBorder
        />
      ) : null}
      <MaterialScreenContent>
        <ThreadSettingsChoiceContent
          submenu={route.params}
          onSelected={() => navigation.goBack()}
        />
      </MaterialScreenContent>
    </>
  );
}

function ThreadSettingsPickerNavigator(props: { readonly onClose: () => void }) {
  const theme = useUniwindTheme();
  const { themeAppearance } = useAppearancePreferences();
  const solidSheetBackground = theme["--color-sheet-solid"];
  const foreground = theme["--color-foreground"];
  const presentation = useMemo(() => ({ onClose: props.onClose }), [props.onClose]);
  const navigationTheme = useMemo(
    () => ({
      dark: themeAppearance === "dark",
      colors: {
        primary: theme["--color-primary"],
        background: solidSheetBackground,
        card: solidSheetBackground,
        text: foreground,
        border: theme["--color-border"],
        notification: theme["--color-danger"],
      },
      fonts: {
        regular: { fontFamily: MOBILE_FONTS.regular, fontWeight: "400" as const },
        medium: { fontFamily: MOBILE_FONTS.medium, fontWeight: "500" as const },
        bold: { fontFamily: MOBILE_FONTS.bold, fontWeight: "600" as const },
        heavy: { fontFamily: MOBILE_FONTS.bold, fontWeight: "800" as const },
      },
    }),
    [foreground, solidSheetBackground, theme, themeAppearance],
  );

  // The sheet hosts its own small navigator, as T3's form-sheet route does, so
  // Reasoning and Permission mode push inside it.
  return (
    <ThreadSettingsPickerPresentationContext.Provider value={presentation}>
      <NavigationIndependentTree>
        <NavigationContainer theme={navigationTheme}>
          <ThreadSettingsPickerStack.Navigator
            initialRouteName="ThreadSettingsModels"
            screenOptions={{
              animation: Platform.OS === "android" ? "default" : "slide_from_right",
              contentStyle: { backgroundColor: solidSheetBackground },
              gestureEnabled: true,
              headerBackButtonDisplayMode: "minimal",
              headerBackTitle: "",
              headerShown: Platform.OS !== "android",
              headerShadowVisible: false,
              headerStyle: {
                backgroundColor: NATIVE_LIQUID_GLASS_SUPPORTED ? "transparent" : solidSheetBackground,
              },
              headerTransparent: NATIVE_LIQUID_GLASS_SUPPORTED,
              headerTintColor: foreground,
              headerTitleStyle: { fontSize: 17, fontWeight: "700" },
              scrollEdgeEffects: NATIVE_LIQUID_GLASS_SUPPORTED
                ? THREAD_SETTINGS_HEADER_SCROLL_EDGE_EFFECTS
                : undefined,
            }}
          >
            <ThreadSettingsPickerStack.Screen
              name="ThreadSettingsModels"
              component={ThreadSettingsModelsScreen}
              options={{ headerBackVisible: false, title: "Session settings" }}
            />
            <ThreadSettingsPickerStack.Screen
              name="ThreadSettingsChoice"
              component={ThreadSettingsChoiceScreen}
              options={({ route }) => ({ title: route.params.title })}
            />
          </ThreadSettingsPickerStack.Navigator>
        </NavigationContainer>
      </NavigationIndependentTree>
    </ThreadSettingsPickerPresentationContext.Provider>
  );
}

/** The model catalog and option screens as a page sheet, bound to the caller's settings. */
export function ThreadSettingsPickerSheet(
  props: ThreadSettingsSessionProps & { readonly visible: boolean; readonly onClose: () => void },
) {
  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      // A form sheet is the page sheet on a phone, and a compact centered
      // card on a tablet, where a page sheet left most of the screen empty.
      presentationStyle="formSheet"
      onRequestClose={props.onClose}
    >
      {props.visible ? (
        <ThreadSettingsSessionProvider {...props}>
          <ThreadSettingsPickerNavigator onClose={props.onClose} />
        </ThreadSettingsSessionProvider>
      ) : null}
    </Modal>
  );
}

/**
 * An open conversation's settings for its next prompt. A model from the other
 * agent switches the session's agent; on a started session that switch waits
 * in the queue and runs the agent's default model.
 */
export function ThreadSettingsSheet(props: {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly store: ConversationStore;
  readonly meta: ConversationMeta;
}) {
  const { store, meta } = props;
  const providerGroups = useMemo(
    () =>
      buildProviderGroups({
        currentProvider: meta.run.provider,
        currentModel: meta.run.model,
        canSwitchProvider: meta.run.provider !== "opencode",
        agents: meta.runOptions.agents,
      }),
    [meta.run.model, meta.run.provider, meta.runOptions.agents],
  );
  const onSelectModel = useCallback(
    (option: ModelOption, effort: ReasoningEffort | null, fastMode: boolean | null) => {
      void (async () => {
        if (option.provider !== store.controller.run.provider && option.provider !== "opencode") {
          await store.controller.switchProvider(option.provider);
        }
        // Only a session the host has not started switches agent at once.
        if (store.controller.run.provider !== option.provider) return;
        store.controller.updateRun({
          model: option.model,
          reasoningEffort: effort ?? undefined,
          fastMode: fastMode ?? undefined,
        });
      })();
    },
    [store],
  );
  return (
    <ThreadSettingsPickerSheet
      visible={props.visible}
      onClose={props.onClose}
      providerGroups={providerGroups}
      selectedProvider={meta.run.provider}
      selectedModel={meta.run.model}
      reasoningEffort={meta.run.reasoningEffort}
      fastMode={meta.run.fastMode}
      permissionMode={meta.run.permissionMode}
      capabilities={meta.runOptions.capabilities}
      canRoute={meta.runOptions.canRoute}
      autoNeedsKey={meta.runOptions.autoNeedsKey}
      onSelectModel={onSelectModel}
      onUpdateReasoningEffort={(effort) => store.controller.updateRun({ reasoningEffort: effort })}
      onUpdateFastMode={(fastMode) => store.controller.updateRun({ fastMode })}
      onUpdatePermissionMode={(mode) => store.controller.updateRun({ permissionMode: mode })}
    />
  );
}
