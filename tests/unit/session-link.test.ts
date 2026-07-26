import { describe, expect, test } from "bun:test";
import {
  resolveSessionLinkMeta,
  type SessionLinkParams,
} from "../../src/renderer/components/conversation/lib/session-link";
import type { SessionMeta } from "../../src/shared/types";

const params: SessionLinkParams = {
  provider: "codex",
  sessionId: "linked-session",
  cwd: "/fallback/project",
};

describe("session links", () => {
  test("uses indexed metadata so a linked session restores its real project and branch directory", async () => {
    const indexed: SessionMeta = {
      provider: "claude-code",
      sessionId: "linked-session",
      slug: "indexed",
      firstMessage: "Indexed session",
      lastTimestamp: "2026-07-24T12:00:00.000Z",
      size: 42,
      cwd: "/repo/.solus-worktrees/feature",
      projectPath: "-repo--solus-worktrees-feature",
      isWorktree: true,
      projectRoot: "/repo",
    };

    const resolved = await resolveSessionLinkMeta(params, async () => indexed);

    expect(resolved).toBe(indexed);
  });

  test("falls back to the embedded cwd when the session index is not ready yet", async () => {
    const resolved = await resolveSessionLinkMeta(params, async () => null);

    expect(resolved).toMatchObject({
      provider: "codex",
      sessionId: "linked-session",
      cwd: "/fallback/project",
      projectPath: "",
    });
  });
});
