import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { LinkMachine } from "@solus/client-core/host-linking";

const testState = vi.hoisted(() => ({ connect: vi.fn(), machines: [] as LinkMachine[] }));
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
vi.mock("../settings/components/SettingsSection", () => ({
  SettingsSection: ({ children, title }: { children?: ReactNode; title: string }) => <section>{title}{children}</section>,
}));
vi.mock("../../solus/use-machine-links", () => ({ useMachineLinks: () => testState.machines }));
vi.mock("../../solus/use-connect-solus-machine", () => ({
  useConnectSolusMachine: () => ({ connect: testState.connect, connecting: false }),
}));

import { LinkedEnvironmentsSection } from "./LinkedEnvironmentsSection";

it("shows the route and access without connecting until the user presses Connect", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const url = "https://build.example.com";
  const source: LinkMachine = {
    label: "Mac",
    info: {
      installationId: "mac", routes: [], principal: "local-owner", permissions: ["host.local.reach"],
      hostKind: "personal", remoteAccess: "private",
    },
    snapshot: { hosts: [{
      listing: { installationId: "build", id: "build", label: "Build", routes: [{ kind: "public", url }], lastConnected: 0 },
      pairedAt: 1, url, clientConnect: "on-request",
    }], forgotten: [] },
    isCurrent: () => true,
    api: {
      hostsPair: vi.fn(), hostsPairClient: vi.fn(), hostsUnlink: vi.fn(), connectionsGeneratePairToken: vi.fn(),
    },
  };
  testState.machines = [source];
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = () => act(() => root.render(<LinkedEnvironmentsSection environmentId="mac" environmentLabel="Mac" />));
  try {
    render();
    expect(container.textContent).toContain("Linked from Mac");
    expect(container.textContent).toContain(`Owner access · Public address · ${url}`);
    expect(testState.connect).not.toHaveBeenCalled();
    act(() => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Connect")?.click());
    expect(testState.connect).toHaveBeenCalledWith("build", "Build", url);
    testState.machines = [];
    render();
    expect(container.textContent).toBe("");
  } finally { act(() => root.unmount()); }
});
