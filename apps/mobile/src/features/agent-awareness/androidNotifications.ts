import Constants from "expo-constants";
import { requireOptionalNativeModule } from "expo";
import { Linking, Platform } from "react-native";

export interface AndroidActivityData {
  readonly active: string;
  readonly updated_at: string;
  readonly activity_chip: string;
  readonly activity_title: string;
  readonly activity_phase: string;
  readonly activity_active_count: string;
  readonly activity_attention_count: string;
  readonly activity_body: string;
  readonly activity_path: string;
  readonly activity_expires_at: string;
  readonly activity_line_0?: string;
  readonly activity_line_1?: string;
  readonly activity_line_2?: string;
  readonly activity_line_3?: string;
  readonly activity_line_4?: string;
}

interface AndroidAgentNotifications {
  configure(deviceId: string, userId: string, scheme: string, ongoingEnabled: boolean): void;
  clear(): void;
  setThreadOnScreen?(path: string | null): void;
  hasLocalActivity?(): boolean;
  updateLocalActivity?(scheme: string, data: AndroidActivityData): void;
  endLocalActivity?(): void;
  openLiveUpdateSettings?(): boolean;
  showShowcaseActivity?(scheme: string, data: Record<string, string>): void;
}

const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<AndroidAgentNotifications>("T3AgentNotifications")
    : null;

export function supportsAndroidAgentNotifications(): boolean {
  return typeof native?.configure === "function" && typeof native?.clear === "function";
}

function appScheme(): string {
  const scheme = Constants.expoConfig?.scheme;
  return (Array.isArray(scheme) ? scheme[0] : scheme) ?? "t3code";
}

export function configureAndroidAgentNotifications(
  deviceId: string,
  userId: string,
  ongoingEnabled: boolean,
): void {
  native?.configure?.(deviceId, userId, appScheme(), ongoingEnabled);
}

export function showAndroidShowcaseAgentActivity(data: Record<string, string>): boolean {
  if (!native?.showShowcaseActivity) return false;
  native.showShowcaseActivity(appScheme(), data);
  return true;
}

export function clearAndroidAgentNotifications(): void {
  native?.clear?.();
}

export function setAndroidThreadOnScreen(path: string | null): void {
  native?.setThreadOnScreen?.(path);
}

export function supportsAndroidLiveUpdateSettings(): boolean {
  return Platform.OS === "android" && Number(Platform.Version) >= 36;
}

export async function openAndroidLiveUpdateSettings(): Promise<void> {
  if (!native?.openLiveUpdateSettings?.()) {
    await Linking.openSettings();
  }
}

export function supportsLocalAndroidActivity(): boolean {
  return typeof native?.updateLocalActivity === "function";
}

export function hasLocalAndroidActivity(): boolean {
  return native?.hasLocalActivity?.() === true;
}

export function updateLocalAndroidActivity(data: AndroidActivityData): boolean {
  if (!native?.updateLocalActivity) return false;
  native.updateLocalActivity(appScheme(), data);
  return true;
}

export function endLocalAndroidActivity(): void {
  native?.endLocalActivity?.();
}
