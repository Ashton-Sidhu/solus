// Adapted from T3 Code apps/mobile/src/features/home/home-thread-navigation.ts (MIT, see UPSTREAM.md).
import {
  CommonActions,
  StackActions,
  useNavigation,
  type NavigationState,
} from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useCallback, useEffect, useRef } from "react";

import type { RootStackParamList } from "../../navigation/routes";
import type { SolusThreadShell } from "../threads/thread-directory";

type ThreadSelection = Pick<SolusThreadShell, "hostId" | "record">;

export function createHomeThreadNavigationAction(input: {
  readonly state: Pick<NavigationState, "index" | "routes">;
  readonly dismissingRouteKey: string | null;
  readonly thread: ThreadSelection;
}) {
  const currentRoute = input.state.routes[input.state.index];
  const params: RootStackParamList["Thread"] = {
    hostId: input.thread.hostId,
    sessionId: input.thread.record.sessionId,
  };

  // Native swipe-back pops the outgoing route after its animation. Reusing
  // that key would also discard this selection when the dismissal arrives.
  if (input.dismissingRouteKey !== null && currentRoute?.key === input.dismissingRouteKey) {
    return StackActions.push("Thread", params);
  }

  return CommonActions.navigate("Thread", params);
}

export function useHomeThreadSelection() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList, "Home">>();
  const dismissingRouteKey = useRef<string | null>(null);

  useEffect(() => {
    const clear = () => {
      dismissingRouteKey.current = null;
    };
    // This listener belongs to Home, so swipe-back is its opening transition.
    // Thread's closing event is targeted at the outgoing Thread route.
    const removeTransitionStart = navigation.addListener("transitionStart", ({ data }) => {
      const state = navigation.getState();
      const currentRoute = state.routes[state.index];
      dismissingRouteKey.current =
        !data.closing && currentRoute?.name === "Thread" ? currentRoute.key : null;
    });
    const removeFocus = navigation.addListener("focus", clear);

    return () => {
      clear();
      removeTransitionStart();
      removeFocus();
    };
  }, [navigation]);

  return useCallback(
    (thread: ThreadSelection) => {
      navigation.dispatch((state) =>
        createHomeThreadNavigationAction({
          state,
          dismissingRouteKey: dismissingRouteKey.current,
          thread,
        }),
      );
    },
    [navigation],
  );
}
