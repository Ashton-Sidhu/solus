import type { HostProvidersAsk } from "@solus/contracts/add-machine";
import type { PendingQuestion } from "@solus-mobile/features/conversation/lib/pending-requests";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

// WHY: docs/host-provider-sign-in.md. After add_host adds a machine, the work
// waits for a provider to sign in there. On the phone the person signs in from
// the card itself, in this phone's browser, through the new host's seat
// sign-in; the host keeps the account and the session host closes the card.
// The card's only answer is "skipped": the phone never claims the sign-in.

const host = vi.hoisted(() => ({
  seatConnectStart: vi.fn(async () => ({ verificationUrl: "https://accounts.example/sign-in", requiresCodeInput: true })),
  seatConnectSubmitCode: vi.fn(async () => ({ submitted: true })),
  openUrl: vi.fn(async () => true),
  openSettings: vi.fn(),
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({ onPress, children, disabled }: { onPress: () => void; children: ReactNode; disabled?: boolean }) => (
    <button disabled={disabled} onClick={onPress}>{children}</button>
  ),
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  AppTextInput: ({ accessibilityLabel, value, onChangeText }: {
    accessibilityLabel: string; value: string; onChangeText: (text: string) => void;
  }) => <input aria-label={accessibilityLabel} value={value} onChange={(event) => onChangeText(event.target.value)} />,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) =>
    <button disabled={disabled} onClick={onPress}>{label}</button>,
}));
vi.mock("../../lib/openExternalUrl", () => ({ tryOpenExternalUrl: host.openUrl }));
vi.mock("../settings/settings-navigation", () => ({ openSettings: host.openSettings }));
vi.mock("@solus-mobile/app/app-context", () => ({ useListened: (_listeners: unknown, read: () => unknown) => read() }));
vi.mock("../../solus/runtime", () => ({
  solus: {
    connections: {
      changes: { subscribe: () => () => {} },
      readiness: () => ({ readiness: "ready" }),
      connection: () => ({ api: { seatConnectStart: host.seatConnectStart, seatConnectSubmitCode: host.seatConnectSubmitCode } }),
    },
  },
}));

import { HostProvidersCard } from "./HostProvidersCard";

const ask: HostProvidersAsk = { installationId: "build-mac", hostName: "Build Mac", provider: "agy", reason: "To run the integration tests there." };
const question: PendingQuestion = { kind: "host-providers", questionId: "sign-in", questions: [], hostProviders: ask };

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.clearAllMocks();
});

async function render(onAnswer = vi.fn(async () => {})) {
  const container = document.createElement("div");
  root = createRoot(container);
  await act(async () => root!.render(
    <HostProvidersCard question={question} ask={ask} responding={false} mayDrive onAnswer={onAnswer} />,
  ));
  const button = (label: string) => Array.from(container.querySelectorAll("button")).find((element) => element.textContent === label);
  return { container, button, onAnswer };
}

it("signs in on the new host from the phone's browser and sends the code back to that host", async () => {
  const { container, button } = await render();
  expect(container.textContent).toContain("Sign in to Google Antigravity on Build Mac");
  await act(async () => button("Sign in")!.click());
  expect(host.seatConnectStart).toHaveBeenCalledWith({ provider: "antigravity" });
  expect(host.openUrl).toHaveBeenCalledWith("https://accounts.example/sign-in");
  const field = container.querySelector("input")!;
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setValue.call(field, " 4/0AVG7fiQ ");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Continue")!.click());
  expect(host.seatConnectSubmitCode).toHaveBeenCalledWith({ provider: "antigravity", code: "4/0AVG7fiQ" });
  // The card waits for the host: only the session host closes it.
  expect(container.textContent).toContain("Finishing your sign-in on Build Mac");
});

it("answers only to skip, and Manage host opens the host's page", async () => {
  const { button, onAnswer } = await render();
  await act(async () => button("Manage host")!.click());
  expect(host.openSettings).toHaveBeenCalledWith(expect.anything(), "SettingsEnvironmentDetail", { environmentId: "build-mac" });
  await act(async () => button("Not now")!.click());
  expect(onAnswer).toHaveBeenCalledWith({ status: "skipped" });
});
