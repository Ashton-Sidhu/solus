// Adapted from T3 Code apps/mobile/src/features/layout/createWorkspaceStackNavigator.ios.tsx (MIT, see UPSTREAM.md).
import {
  createNavigatorFactory,
  NavigationContext,
  NavigationRouteContext,
  StackRouter,
  useNavigationBuilder,
  type NavigatorTypeBagBase,
  type ParamListBase,
  type StackActionHelpers,
  type StackNavigationState,
  type StackRouterOptions,
  type StaticConfig,
  type TypedNavigator,
} from "@react-navigation/native";
import {
  NativeStackView,
  type NativeStackNavigationEventMap,
  type NativeStackNavigationOptions,
  type NativeStackNavigatorProps,
  type NativeStackTypeBag,
} from "@react-navigation/native-stack";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { Split, type SplitHostCommands } from "react-native-screens";

import { NativeColumnContent as ColumnContent } from "../../native/NativeColumnContent.ios";
import {
  isModalPresentation,
  modalEnvelopeOptions,
  V5CardStackView,
  V5StackView,
} from "../../native/createV5StackNavigator.ios";
import { NATIVE_WORKSPACE_COLUMNS_SUPPORTED } from "../../native/NativeWorkspaceColumns";
import { V5StackHeader } from "../../native/V5StackHeader.ios";
import {
  NativePrimaryColumnContext,
  NativeWorkspaceModeContext,
} from "../../native/v5-workspace-context";
import {
  collapsedSplitTransition,
  nativeWorkspacePopAction,
  partitionStackPresentations,
  projectWorkspaceStack,
  type CollapsedSplitColumn,
} from "../../native/workspace-stack-projection";
import type { RootStackParamList } from "../../navigation/routes";
import { threadKey } from "../threads/thread-directory";
import { WorkspaceNativeTabs } from "../workspace/WorkspaceNativeTabs.ios";
import { useAdaptiveWorkspaceLayout } from "./AdaptiveWorkspaceLayout";
import { WorkspaceEmptyDetail } from "./WorkspaceEmptyDetail";

type ViewProps = ComponentProps<typeof NativeStackView>;
type Descriptor = ViewProps["descriptors"][string];
type Route = ViewProps["state"]["routes"][number];

function ColumnScreen(props: {
  readonly descriptor: Descriptor;
  readonly primary?: boolean;
  readonly selectedThreadKey?: string | null;
  readonly onDismiss: (routeKey: string) => void;
  readonly onAppearance: (type: "willAppear" | "didAppear" | "willDisappear", key: string) => void;
  readonly navigation: ViewProps["navigation"];
}) {
  const { descriptor } = props;
  const primaryColumn = useMemo(
    () => (props.primary ? { selectedThreadKey: props.selectedThreadKey ?? null } : null),
    [props.primary, props.selectedThreadKey],
  );
  const key = descriptor.route.key;
  return (
    <Split.Screen
      screenKey={key}
      onDismiss={(event) => {
        if (event.nativeEvent.isNativeDismiss) props.onDismiss(key);
      }}
      onWillAppear={() => {
        props.onAppearance("willAppear", key);
        props.navigation.emit({ type: "transitionStart", target: key, data: { closing: false } });
      }}
      onDidAppear={() => {
        props.onAppearance("didAppear", key);
        props.navigation.emit({ type: "transitionEnd", target: key, data: { closing: false } });
      }}
      onWillDisappear={() => {
        props.onAppearance("willDisappear", key);
        props.navigation.emit({ type: "transitionStart", target: key, data: { closing: true } });
      }}
      onDidDisappear={() =>
        props.navigation.emit({ type: "transitionEnd", target: key, data: { closing: true } })
      }
    >
      <NavigationContext value={descriptor.navigation}>
        <NavigationRouteContext value={descriptor.route}>
          <V5StackHeader options={descriptor.options} canGoBack={!props.primary} />
          <ColumnContent primary={props.primary}>
            <NativePrimaryColumnContext value={primaryColumn}>
              {descriptor.render()}
            </NativePrimaryColumnContext>
          </ColumnContent>
        </NavigationRouteContext>
      </NavigationContext>
    </Split.Screen>
  );
}

/** The thread the detail column shows, so the primary column can mark its row. */
function selectedThreadKeyOf(detail: readonly Route[]): string | null {
  const thread = detail.findLast((route) => route.name === "Thread");
  // SAFETY: a route named 'Thread' is only pushed with `RootStackParamList['Thread']` params.
  const params = thread?.params as RootStackParamList["Thread"] | undefined;
  return params ? threadKey(params.hostId, params.sessionId) : null;
}

/** iPad: Home in UIKit's primary column, every pushed route in the secondary column. */
function WorkspaceColumns(
  props: ViewProps & { readonly primary: Route; readonly detail: Route[] },
) {
  const { layout, panes, togglePrimarySidebar } = useAdaptiveWorkspaceLayout();
  const hostRef = useRef<SplitHostCommands>(null);
  const activeDetailKey = props.detail.at(-1)?.key;
  const compactColumn = activeDetailKey ? "secondary" : "primary";
  const collapsed = useRef(!layout.usesSplitView);
  const collapsedColumn = useRef<CollapsedSplitColumn>({ visible: compactColumn, leaving: null });
  const handleNativeDismiss = useCallback(
    (key: string) => {
      const action = nativeWorkspacePopAction(props.navigation.getState(), key);
      if (action) props.navigation.dispatch(action);
    },
    [props.navigation],
  );
  const followCollapsedSplit = (
    type: "willAppear" | "didAppear" | "willDisappear",
    key: string,
  ) => {
    if (!collapsed.current || layout.usesSplitView) return;
    const transition = collapsedSplitTransition(
      collapsedColumn.current,
      { type, key },
      props.navigation.getState(),
      props.primary.key,
    );
    collapsedColumn.current = transition.column;
    if (transition.pop) props.navigation.dispatch(transition.pop);
  };

  useEffect(() => {
    // In compact size classes UIKit exposes one column. Selecting a thread
    // changes the visible column without rebuilding either navigation stack.
    // The initial column is a native prop, so it is applied before the host
    // attaches. Commands only handle later navigation changes.
    if (layout.usesSplitView || collapsedColumn.current.visible === compactColumn) return;
    collapsedColumn.current = { ...collapsedColumn.current, visible: compactColumn };
    hostRef.current?.show(compactColumn);
  }, [compactColumn, layout.usesSplitView]);

  const primary = props.descriptors[props.primary.key];
  if (!primary) return null;
  return (
    <Split.Host
      ref={hostRef}
      testID="adaptive-workspace-layout"
      preferredSplitBehavior="tile"
      topColumnForCollapsing={compactColumn}
      onCollapse={() => {
        collapsed.current = true;
        collapsedColumn.current = { visible: compactColumn, leaving: null };
      }}
      onExpand={() => {
        collapsed.current = false;
      }}
      preferredDisplayMode={
        panes.primarySidebarVisible || !activeDetailKey ? "oneBesideSecondary" : "secondaryOnly"
      }
      displayModeButtonVisibility="never"
      presentsWithGesture
      columnMetrics={{
        minimumPrimaryColumnWidth: 280,
        maximumPrimaryColumnWidth: Math.max(380, layout.listPaneWidth ?? 0),
        preferredPrimaryColumnWidthOrFraction: layout.listPaneWidth ?? 320,
        minimumSecondaryColumnWidth: 320,
      }}
    >
      <Split.Column>
        <Split.Stack>
          <ColumnScreen
            descriptor={primary}
            primary
            selectedThreadKey={selectedThreadKeyOf(props.detail)}
            onDismiss={handleNativeDismiss}
            onAppearance={followCollapsedSplit}
            navigation={props.navigation}
          />
        </Split.Stack>
      </Split.Column>
      <Split.Column>
        <Split.Stack>
          <Split.Screen
            screenKey="workspace-empty"
            activityMode={layout.usesSplitView && !activeDetailKey ? "attached" : "detached"}
          >
            <V5StackHeader
              options={{
                headerShown: true,
                title: "",
                unstable_headerLeftItems: () => [
                  {
                    type: "button",
                    label: "",
                    accessibilityLabel: "Toggle sidebar",
                    icon: { type: "sfSymbol", name: "sidebar.left" },
                    onPress: togglePrimarySidebar,
                  },
                ],
              }}
              canGoBack={false}
            />
            <ColumnContent>
              <WorkspaceEmptyDetail onStartNewTask={() => props.navigation.navigate("NewTask")} />
            </ColumnContent>
          </Split.Screen>
          {props.detail.map((route) => {
            const descriptor = props.descriptors[route.key];
            return descriptor ? (
              <ColumnScreen
                key={route.key}
                descriptor={descriptor}
                onDismiss={handleNativeDismiss}
                onAppearance={followCollapsedSplit}
                navigation={props.navigation}
              />
            ) : null;
          })}
        </Split.Stack>
      </Split.Column>
    </Split.Host>
  );
}

/**
 * One router history, three native containers: the workspace (Home and its
 * pushed routes) inside the system tab bar, as columns on iPad or as a card
 * stack on a phone, and each sheet or modal above it with its own pushes.
 */
function WorkspaceStackView(props: ViewProps) {
  const { layout } = useAdaptiveWorkspaceLayout();
  // Native dismiss commits the route pop after the transition. Restore the tab
  // bar when the primary screen starts appearing, including interactive back gestures.
  const [primaryVisible, setPrimaryVisible] = useState(false);
  const projection = projectWorkspaceStack(props.state, (route) =>
    isModalPresentation(props.descriptors[route.key]?.options),
  );
  // A history without Home (a restored state) stays a single stack:
  // placeholder descriptors cannot own an interactive sidebar.
  const primaryRoute = projection.primary;
  if (!primaryRoute) return <V5StackView {...props} />;
  const primaryDescriptor = props.descriptors[primaryRoute.key]!;
  const baseRoute = { key: `${props.state.key}:workspace`, name: "Workspace" };
  const visibleRoute = projection.detail.at(-1) ?? primaryRoute;
  const baseDescriptor: Descriptor = {
    ...primaryDescriptor,
    navigation: props.descriptors[visibleRoute.key]!.navigation,
    // The native envelope keeps a stable key, but its NavigationProvider must
    // identify the real visible route or useIsFocused closes media viewers.
    route: visibleRoute,
    options: { headerShown: false },
    render: () => (
      <WorkspaceNativeTabs
        onNewTask={() => props.navigation.navigate("NewTask")}
        hidden={projection.detail.length > 0 && !primaryVisible && !layout.usesSplitView}
        onSelect={() => {
          if (props.state.index > 0)
            props.navigation.dispatch({ type: "POP_TO_TOP", target: props.state.key });
        }}
      >
        {NATIVE_WORKSPACE_COLUMNS_SUPPORTED ? (
          <WorkspaceColumns {...props} primary={primaryRoute} detail={projection.detail} />
        ) : (
          <V5CardStackView
            {...props}
            onRootVisibilityChange={setPrimaryVisible}
            state={{
              ...props.state,
              routes: [primaryRoute, ...projection.detail],
              index: projection.detail.length,
              preloadedRoutes: [],
            }}
          />
        )}
      </WorkspaceNativeTabs>
    ),
  };
  const overlays = partitionStackPresentations(projection.overlays, (route) =>
    isModalPresentation(props.descriptors[route.key]?.options),
  );
  const routes = [baseRoute, ...overlays.map((group) => group[0]!)];
  return (
    <NativeStackView
      presentationEnvelope
      {...props}
      state={{ ...props.state, routes, index: routes.length - 1, preloadedRoutes: [] }}
      descriptors={{
        ...Object.fromEntries(
          overlays.map((group) => {
            const route = group[0]!;
            const descriptor = props.descriptors[route.key]!;
            const visibleRoute = group.at(-1)!;
            return [
              route.key,
              {
                ...descriptor,
                navigation: props.descriptors[visibleRoute.key]!.navigation,
                route: visibleRoute,
                options: modalEnvelopeOptions(descriptor.options),
                render: () => (
                  <V5CardStackView
                    {...props}
                    state={{
                      ...props.state,
                      routes: group,
                      index: group.length - 1,
                      preloadedRoutes: [],
                    }}
                  />
                ),
              },
            ];
          }),
        ),
        [baseRoute.key]: baseDescriptor,
      }}
    />
  );
}

function WorkspaceStackNavigator({
  id,
  initialRouteName,
  UNSTABLE_routeNamesChangeBehavior,
  children,
  layout,
  screenListeners,
  screenOptions,
  screenLayout,
  UNSTABLE_router,
  ...rest
}: NativeStackNavigatorProps) {
  const { state, describe, descriptors, navigation, NavigationContent } = useNavigationBuilder<
    StackNavigationState<ParamListBase>,
    StackRouterOptions,
    StackActionHelpers<ParamListBase>,
    NativeStackNavigationOptions,
    NativeStackNavigationEventMap
  >(StackRouter, {
    id,
    initialRouteName,
    UNSTABLE_routeNamesChangeBehavior,
    children,
    layout,
    screenListeners,
    screenOptions,
    screenLayout,
    UNSTABLE_router,
  });
  return (
    <NativeWorkspaceModeContext value={NATIVE_WORKSPACE_COLUMNS_SUPPORTED}>
      <NavigationContent>
        <WorkspaceStackView
          {...rest}
          state={state}
          describe={describe}
          descriptors={descriptors}
          navigation={navigation}
        />
      </NavigationContent>
    </NativeWorkspaceModeContext>
  );
}

type WorkspaceTypeBag<
  ParamList extends ParamListBase,
  NavigatorID extends string | undefined,
> = Omit<NativeStackTypeBag<ParamList, NavigatorID>, "Navigator"> & {
  Navigator: typeof WorkspaceStackNavigator;
};

export function createWorkspaceStackNavigator<
  const ParamList extends ParamListBase,
  const NavigatorID extends string | undefined = string | undefined,
  const TypeBag extends NavigatorTypeBagBase = WorkspaceTypeBag<ParamList, NavigatorID>,
  const Config extends StaticConfig<TypeBag> = StaticConfig<TypeBag>,
>(config?: Config): TypedNavigator<TypeBag, Config> {
  return createNavigatorFactory(WorkspaceStackNavigator)(config);
}
