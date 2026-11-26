import type { CloudMachineAsk } from "@solus/contracts/cloud-machine-card";
import type { PendingQuestion } from "@solus-mobile/features/conversation/lib/pending-requests";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({ onPress, children, disabled }: { onPress: () => void; children: ReactNode; disabled?: boolean }) => (
    <button disabled={disabled} onClick={onPress}>{children}</button>
  ),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
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
vi.mock("../../components/ui/ListChoiceRow", () => ({
  ListChoiceRow: ({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) =>
    <button role="radio" aria-checked={selected} onClick={onPress}>{label}</button>,
}));
vi.mock("../../components/ui/Sheet", () => ({
  Sheet: ({ title, children }: { title: string; children: ReactNode }) => <section aria-label={title}>{children}</section>,
}));
vi.mock("../settings/components/SettingsSection", () => ({
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => <fieldset title={title}>{children}</fieldset>,
}));

import { CloudMachineCard } from "./CloudMachineCard";

const organizations = [
  { id: "acme", name: "Acme" },
  { id: "side", name: "Side project" },
];
const createAsk: CloudMachineAsk = {
  mode: "create",
  reason: "A machine with Docker for the CI image builds.",
  organizations,
  catalog: {
    sizes: [
      { id: "small", label: "Small", detail: "", cpus: 2, memoryGb: 4 },
      { id: "standard", label: "Standard", detail: "", cpus: 4, memoryGb: 16 },
    ],
    defaultSize: "standard",
    supportsPackages: true,
    supportsSetupScript: false,
  },
  draft: { name: "Build box", packages: ["docker.io"] },
};
const editAsk: CloudMachineAsk = {
  mode: "edit",
  reason: "You did not say what to change.",
  host: { hostId: "h1", name: "Build box", state: "ready", size: "Standard" },
  current: { packages: ["docker.io", "jq"], setupScript: "#!/bin/sh\n" },
};

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

function render(ask: CloudMachineAsk, options: { mayDrive?: boolean; question?: Partial<PendingQuestion> } = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  root = createRoot(container);
  const onAnswer = vi.fn(async (_answers: Record<string, string>) => {});
  const question: PendingQuestion = { kind: "cloud-machine", questionId: "q", questions: [], cloudMachine: ask, ...options.question };
  act(() => root!.render(
    <CloudMachineCard question={question} ask={ask} responding={false} mayDrive={options.mayDrive ?? true} onAnswer={onAnswer} />,
  ));
  const button = (label: string) =>
    Array.from(container.querySelectorAll("button")).find((element) => element.textContent === label);
  const type = (label: string, text: string) => {
    const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  return { container, onAnswer, button, type };
}

// The tool cannot make a machine without an organization, so the card must not send one.
it("asks for the missing organization, checks packages, and answers the create card", async () => {
  const card = render(createAsk);
  expect(card.container.textContent).toContain("Choose one");
  expect(card.container.textContent).toContain("Standard · 4 CPU · 16 GB");
  act(() => card.button("Review machine…")!.click());
  expect(card.button("Create machine")!.disabled).toBe(true);
  act(() => card.button("Acme")!.click());
  expect(card.button("Create machine")!.disabled).toBe(false);
  card.type("Packages", "docker.io rm;-rf");
  expect(card.container.textContent).toContain('"rm;-rf" is not a package name.');
  expect(card.button("Create machine")!.disabled).toBe(true);
  card.type("Packages", "docker.io jq");
  await act(async () => card.button("Create machine")!.click());
  expect(card.onAnswer).toHaveBeenCalledWith({
    status: "chosen", organizationId: "acme", name: "Build box", size: "standard", packages: "docker.io jq",
  });
});

it("warns that a running machine restarts and saves its setup", async () => {
  const card = render(editAsk);
  expect(card.container.textContent).toContain("The machine restarts to take the change. Its sessions stop.");
  expect(card.container.textContent).toContain("1 line");
  act(() => card.button("Edit setup…")!.click());
  card.type("Packages", "docker.io jq ripgrep");
  await act(async () => card.button("Save and restart")!.click());
  expect(card.onAnswer).toHaveBeenCalledWith({ status: "chosen", packages: "docker.io jq ripgrep", setupScript: "#!/bin/sh\n" });
});

it("declines with the status only", async () => {
  const card = render(editAsk);
  await act(async () => card.button("Decline")!.click());
  expect(card.onAnswer).toHaveBeenCalledWith({ status: "declined" });
});

it("shows a viewer that an editor answers, and an expired card without controls", () => {
  const viewer = render(createAsk, { mayDrive: false });
  expect(viewer.container.textContent).toContain("Waiting for an editor");
  expect(viewer.button("Review machine…")).toBeUndefined();
  act(() => root?.unmount());
  const expired = render(createAsk, { question: { expired: "run_ended" } });
  expect(expired.button("Review machine…")).toBeUndefined();
  expect(expired.button("Decline")).toBeUndefined();
  expect(expired.container.textContent).toContain("No longer answerable — the run ended.");
});
