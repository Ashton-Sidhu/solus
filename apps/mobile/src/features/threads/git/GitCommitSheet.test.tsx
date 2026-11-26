import type { GitActionRequestInput } from "@t3tools/client-runtime/state/vcs";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type PressProps = {
  label?: string;
  accessibilityLabel?: string;
  accessibilityState?: { checked?: boolean };
  onPress: () => void;
};
const state = vi.hoisted(() => ({
  refName: "main",
  result: false,
  scope: "account-a",
  pressables: [] as PressProps[],
  buttons: [] as PressProps[],
  ran: [] as GitActionRequestInput[],
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => children,
  Pressable: (props: PressProps & { children: ReactNode }) => {
    state.pressables.push(props);
    return null;
  },
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: () => {} }) }));
vi.mock("../../../components/ui/SheetHeader", () => ({ SheetHeader: () => null }));
vi.mock("../../../components/ui/FitSheet", () => ({
  FitSheet: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../../components/ui/AppText", () => ({
  AppText: () => null,
  AppTextInput: () => null,
}));
vi.mock("../../../components/ui/Button", () => ({
  Button: (props: PressProps) => {
    state.buttons.push(props);
    return null;
  },
}));
vi.mock("../../../state/host-query-scope", () => ({ useHostQueryScope: () => state.scope }));
vi.mock("../../../solus/use-session-controller", () => ({
  useSessionController: () => ({ hostId: "environment", canChooseStart: true }),
}));
vi.mock("../../../solus/CheckoutGit", () => ({
  useCheckoutGitTarget: () => ({ cwd: "/repo" }),
  useCheckoutCommit: () => ({
    git: {
      status: { refName: state.refName, isDefaultRef: false },
      busy: false,
      canWrite: true,
      perform: (input: GitActionRequestInput) => {
        state.ran.push(input);
        return Promise.resolve(state.result);
      },
    },
    files: {
      data: [
        { path: "include.ts", insertions: 1, deletions: 0 },
        { path: "later.ts", insertions: 1, deletions: 0 },
      ],
    },
  }),
}));
vi.mock("../../files/FilePreviewFeedback", () => ({ FilePreviewLoading: () => null }));
vi.mock("../../../components/ui/EmptyState", () => ({ EmptyState: () => null }));

import { GitCommitSheet } from "./GitCommitSheet";

function openSheet() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  const render = () => {
    state.pressables = [];
    state.buttons = [];
    root.render(
      <GitCommitSheet route={{ params: { environmentId: "environment", threadId: "thread" } }} />,
    );
  };
  act(render);
  const row = (path: string) => state.pressables.findLast((p) => p.accessibilityLabel === path)!;
  return {
    isIncluded: (path: string) => row(path).accessibilityState?.checked,
    close: () => act(() => root.unmount()),
    toggle: (path: string) => act(() => row(path).onPress()),
    // The sheet closes on submit, so it unmounts once the commit settles.
    commit: async () => {
      await act(async () => state.buttons.findLast((b) => b.label === "Commit changes")!.onPress());
      act(() => root.unmount());
    },
  };
}

it("keeps excluded files after a failed commit until a commit succeeds", async () => {
  const first = openSheet();
  first.toggle("later.ts");
  state.result = false;
  await first.commit();

  const retry = openSheet();
  expect(retry.isIncluded("later.ts")).toBe(false);
  expect(retry.isIncluded("include.ts")).toBe(true);
  state.result = true;
  await retry.commit();
  expect(state.ran).toEqual([
    { action: "commit", featureBranch: false, filePaths: ["include.ts"] },
    { action: "commit", featureBranch: false, filePaths: ["include.ts"] },
  ]);

  const reopened = openSheet();
  expect(reopened.isIncluded("later.ts")).toBe(true);
  reopened.close();
});

it("does not restore excluded files after an account or checkout change", async () => {
  state.result = false;
  const first = openSheet();
  first.toggle("later.ts");
  await first.commit();

  state.refName = "another-branch";
  const anotherBranch = openSheet();
  expect(anotherBranch.isIncluded("later.ts")).toBe(true);
  anotherBranch.close();

  state.refName = "main";
  state.scope = "account-b";
  const anotherAccount = openSheet();
  expect(anotherAccount.isIncluded("later.ts")).toBe(true);
  anotherAccount.close();
});
