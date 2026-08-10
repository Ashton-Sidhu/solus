import { describe, expect, test } from "bun:test";
import {
  parseSessionHref,
  resolveSessionLinkMeta,
  type SessionLinkParams,
} from "../../src/renderer/components/conversation/lib/session-link";
import type { SessionMeta } from "../../src/shared/types";

const params: SessionLinkParams = {
  provider: "codex",
  sessionId: "linked-session",
  serverId: null,
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

    const resolved = await resolveSessionLinkMeta(
      params,
      "studio",
      async () => indexed,
    );

    expect(resolved).toBe(indexed);
    expect(resolved.serverId).toBe("studio");
  });

  test("falls back to the embedded cwd when the session index is not ready yet", async () => {
    const resolved = await resolveSessionLinkMeta(
      params,
      "studio",
      async () => null,
    );

    expect(resolved).toMatchObject({
      provider: "codex",
      sessionId: "linked-session",
      cwd: "/fallback/project",
      projectPath: "",
      serverId: "studio",
    });
  });

  test("an explicit link host wins over the transcript host", async () => {
    const parsed = parseSessionHref(
      "session://open?provider=codex&sessionId=linked-session&serverId=laptop&cwd=%2Frepo",
    );
    expect(parsed?.serverId).toBe("laptop");

    let resolvedServerId: string | null | undefined;
    const resolved = await resolveSessionLinkMeta(
      parsed!,
      "studio",
      async (ref) => {
        resolvedServerId = ref.serverId;
        return null;
      },
    );

    expect(resolvedServerId).toBe("laptop");
    expect(resolved.serverId).toBe("laptop");
  });
});
