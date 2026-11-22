import { modelLabel } from "@solus-mobile/features/conversation/lib/run-settings";
import { expect, it } from "vite-plus/test";
import { toThreadShell, type SessionRow } from "./session";

const session: SessionRow = {
  sessionId: "same-id",
  provider: "claude-code",
  projectPath: "/project",
  model: null,
  title: "Original",
  customTitle: "Release notes",
  createdAt: 1000,
  lastActivityAt: 2000,
  branch: "release",
  cwd: "/checkout",
  isWorktree: true,
  status: "running",
};

it("keeps the host and worktree when opening a renamed session", () => {
  expect(toThreadShell("remote", session, "accept-edits")).toMatchObject({
    environmentId: "remote",
    id: "same-id",
    title: "Release notes",
    projectId: "/project",
    branch: "release",
    worktreePath: "/checkout",
    runtimeMode: "auto-accept-edits",
    modelSelection: { instanceId: "claudeAgent", model: "auto" },
  });
});


it("uses the host model label or the Solus catalog name for the composer", () => {
  expect(modelLabel("claude-code", "claude-opus-5-5")).toBe("Opus 5.5");
  expect(modelLabel("codex", "custom", { models: [{ id: "custom", label: "Team model" }] })).toBe("Team model");
});
