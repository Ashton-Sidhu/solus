import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { LinkMachine, MachineLinksHidden } from "@solus/client-core/host-linking";
import type { HostLinkHealth, HostPairing } from "@solus/contracts/host-pairing";

const testState = vi.hoisted(() => ({
  connect: vi.fn(),
  refresh: vi.fn(),
  machines: [] as LinkMachine[],
  hidden: null as MachineLinksHidden | null,
  health: new Map<string, readonly HostLinkHealth[] | "unavailable">(),
  known: new Set<string>(),
}));
vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => <button onClick={onPress}>{label}</button>,
}));
vi.mock("../../components/StatusPill", () => ({
  StatusPill: ({ label, pillClassName }: { label: string; pillClassName: string }) => <em data-tone={pillClassName}>{label}</em>,
}));
vi.mock("./connectionTone", () => ({
  connectionTone: (phase: string) => ({ label: phase, pillClassName: phase, textClassName: "" }),
}));
vi.mock("../settings/components/SettingsSection", () => ({
  SettingsSection: ({ children, title }: { children?: ReactNode; title: string }) => <section>{title}{children}</section>,
}));
vi.mock("../../solus/use-machine-links", () => ({
  useMachineLinks: () => testState.machines,
  useMachineLinksHidden: () => testState.hidden,
  useLinkHealth: () => testState.health,
  useKnownMachineIds: () => testState.known,
  refreshMachineLinks: testState.refresh,
  readLinkHealth: vi.fn(),
}));
vi.mock("../../solus/use-connect-solus-machine", () => ({
  useConnectSolusMachine: () => ({ connect: testState.connect, connecting: false }),
}));

import { LinkedEnvironmentsSection } from "./LinkedEnvironmentsSection";

const MAC_URL = "https://mac.example.com";
const BUILD_URL = "https://build.example.com";

function pairing(id: string, label: string, url: string): HostPairing {
  return {
    listing: { installationId: id, id, label, routes: [{ kind: "lan", url: "http://192.168.1.9:7777" }, { kind: "public", url }], lastConnected: 0, identityKey: `${id}-key` },
    pairedAt: Date.UTC(2026, 0, 2), url, clientConnect: "on-request",
  };
}

function machine(id: string, label: string, url: string, links: HostPairing[]): LinkMachine {
  return {
    label,
    info: { installationId: id, identityKey: `${id}-key`, routes: [{ kind: "public", url }], principal: "local-owner", permissions: ["host.local.reach"], hostKind: "personal", remoteAccess: "private" },
    snapshot: { hosts: links, forgotten: [] },
    isCurrent: () => true,
    api: {
      hostsPair: vi.fn(async () => ({}) as never), hostsPairClient: vi.fn(), hostsUnlink: vi.fn(),
      connectionsGeneratePairToken: vi.fn(async () => ({ token: "one-use" }) as never), hostsLinkHealth: vi.fn(),
    },
  };
}

function renderSection() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<LinkedEnvironmentsSection environmentId="mac" environmentLabel="Mac" />));
  const button = (label: string) => Array.from(container.querySelectorAll("button")).find((element) => element.textContent === label);
  return { container, root, button };
}

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  testState.hidden = null;
  testState.health = new Map();
  testState.known = new Set();
  testState.machines = [];
  vi.clearAllMocks();
});

it("shows a failing link with its last error, every address, and Connect only when pressed", () => {
  testState.machines = [machine("mac", "Mac", MAC_URL, [pairing("build", "Build", BUILD_URL)])];
  testState.known = new Set(["mac", "build"]);
  testState.health = new Map([["mac", [{ installationId: "build", status: "reachable", lastReachedAt: Date.now() - 5 * 60_000, lastError: "The machine refused this host's credential.", expiresAt: null }]]]);
  const { container, root, button } = renderSection();
  unmount = () => act(() => root.unmount());
  const text = container.textContent ?? "";
  expect(text).toContain("Linked from Mac");
  expect(container.querySelector("em")?.textContent).toBe("Failing");
  expect(container.querySelector("em")?.dataset.tone).toBe("error");
  expect(text).toContain("The machine refused this host's credential.");
  expect(text).toContain("Owner access");
  expect(text).toContain("Last reached 5 min ago");
  expect(text).toContain(`Linked ${new Date(Date.UTC(2026, 0, 2)).toLocaleDateString()}`);
  expect(text.indexOf(`Public address · ${BUILD_URL}`)).toBeLessThan(text.indexOf("Local network · http://192.168.1.9:7777"));
  expect(testState.connect).not.toHaveBeenCalled();
  act(() => button("Connect")?.click());
  expect(testState.connect).toHaveBeenCalledWith("build", "Build", BUILD_URL);
});

it("shows Health unknown for a host that cannot give health, not a check that never ends", () => {
  testState.machines = [machine("mac", "Mac", MAC_URL, [pairing("build", "Build", BUILD_URL)])];
  testState.health = new Map([["mac", "unavailable"]]);
  const { container, root } = renderSection();
  unmount = () => act(() => root.unmount());
  expect(container.querySelector("em")?.textContent).toBe("Health unknown");
  expect(container.textContent).not.toContain("Checking");
});

it("offers Link back on a one-way link, and links the target to the source", async () => {
  const mac = machine("mac", "Mac", MAC_URL, [pairing("build", "Build", BUILD_URL)]);
  const build = machine("build", "Build", BUILD_URL, []);
  testState.machines = [mac, build];
  testState.known = new Set(["mac", "build"]);
  const { container, root, button } = renderSection();
  unmount = () => act(() => root.unmount());
  expect(container.textContent).toContain("One-way link");
  await act(async () => button("Link back")?.click());
  expect(build.api.hostsPair).toHaveBeenCalledWith(expect.objectContaining({ url: MAC_URL, link: { installationId: "mac", identityKey: "mac-key" } }));
  expect(mac.api.hostsPair).not.toHaveBeenCalled();
});

it("shows a two-way link once, from this machine's side, with no Link back", () => {
  testState.machines = [
    machine("build", "Build", BUILD_URL, [pairing("mac", "Mac", MAC_URL)]),
    machine("mac", "Mac", MAC_URL, [pairing("build", "Build", BUILD_URL)]),
  ];
  testState.known = new Set(["mac", "build"]);
  const { container, root, button } = renderSection();
  unmount = () => act(() => root.unmount());
  expect(container.textContent).toContain("Two-way link");
  expect(container.textContent).toContain("Build links back");
  expect(container.querySelectorAll("em")).toHaveLength(1);
  expect(button("Link back")).toBeUndefined();
});

it("labels a machine that this phone knows only through the link", () => {
  testState.machines = [machine("mac", "Mac", MAC_URL, [pairing("build", "Build", BUILD_URL)])];
  testState.known = new Set(["mac"]);
  const { container, root, button } = renderSection();
  unmount = () => act(() => root.unmount());
  expect(container.textContent).toContain("Known only through a link");
  expect(button("Connect")).toBeDefined();
});

it("says why the links are not shown, with Retry after a failed read", () => {
  testState.hidden = "failed";
  const { container, root, button } = renderSection();
  unmount = () => act(() => root.unmount());
  expect(container.textContent).toContain("Could not read its machine links.");
  act(() => button("Retry")?.click());
  expect(testState.refresh).toHaveBeenCalledWith("mac");
  testState.hidden = "not-owner";
  act(() => root.render(<LinkedEnvironmentsSection environmentId="mac" environmentLabel="Mac" />));
  expect(container.textContent).toContain("Only its owner can see its machine links.");
  expect(button("Retry")).toBeUndefined();
});
