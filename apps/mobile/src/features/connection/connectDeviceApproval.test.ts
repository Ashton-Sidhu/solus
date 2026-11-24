import type { PairApprovalRequest } from "@solus/contracts/add-machine";
import { describe, expect, it } from "vite-plus/test";

import { createApprovalPromptQueue, pairApprovalPrompts } from "./connectDeviceApproval";

const request = (requestId: string, requestedAt: number, expiresAt = requestedAt + 300_000) =>
  ({
    requestId,
    checkCode: requestId === "older" ? "K7QM-2XFD" : "WXYZ-2345",
    deviceLabel: requestId === "older" ? "Studio Mac" : "Laptop",
    fromAddress: "10.0.0.7",
    requestedAt,
    expiresAt,
  }) satisfies PairApprovalRequest;

describe("pairApprovalPrompts", () => {
  // The person approves only when the codes match, so the prompt must show the code and name both machines.
  it("prompts once per open request, oldest first, with the check code and both machines", () => {
    const prompts = pairApprovalPrompts({
      hostId: "mini",
      hostLabel: "Mac mini",
      approvals: [request("newer", 2_000), request("shown", 500), request("older", 1_000)],
      shownIds: new Set(["mini:shown"]),
      now: 3_000,
    });

    expect(prompts.map((prompt) => prompt.pairingLinkId)).toEqual(["mini:older", "mini:newer"]);
    expect(prompts[0]?.requestId).toBe("older");
    expect(prompts[0]?.message).toContain("Studio Mac at 10.0.0.7 wants to pair with Mac mini");
    expect(prompts[0]?.message).toContain("K7QM-2XFD");
  });

  it("does not prompt for a request that expired", () => {
    const prompts = pairApprovalPrompts({
      hostId: "mini",
      hostLabel: "Mac mini",
      approvals: [request("older", 1_000, 2_000)],
      shownIds: new Set(),
      now: 2_000,
    });
    expect(prompts).toEqual([]);
  });

  // Two hosts can hold requests with the same id; each host's prompt is its own.
  it("keys a prompt by its host and its request", () => {
    const shown = new Set(["mini:older"]);
    const prompts = pairApprovalPrompts({
      hostId: "studio",
      hostLabel: "Studio",
      approvals: [request("older", 1_000)],
      shownIds: shown,
      now: 1_500,
    });
    expect(prompts.map((prompt) => prompt.pairingLinkId)).toEqual(["studio:older"]);
  });
});

describe("createApprovalPromptQueue", () => {
  it("shows one prompt at a time and offers a failed one again before the rest", () => {
    const shown: string[] = [];
    const answers: Array<(outcome: "done" | "retry" | "later") => void> = [];
    const queue = createApprovalPromptQueue<{ pairingLinkId: string }>((prompt, answer) => {
      shown.push(prompt.pairingLinkId);
      answers.push(answer);
    });

    queue.offer([{ pairingLinkId: "a" }, { pairingLinkId: "b" }]);
    queue.offer([{ pairingLinkId: "a" }]);
    expect(shown).toEqual(["a"]);

    answers.at(-1)!("retry");
    expect(shown).toEqual(["a", "a"]);
    answers.at(-1)!("done");
    expect(shown).toEqual(["a", "a", "b"]);
  });

  it("waits for the next offer when another dialog replaced the prompt", () => {
    const shown: string[] = [];
    const answers: Array<(outcome: "done" | "retry" | "later") => void> = [];
    const queue = createApprovalPromptQueue<{ pairingLinkId: string }>((prompt, answer) => {
      shown.push(prompt.pairingLinkId);
      answers.push(answer);
    });

    queue.offer([{ pairingLinkId: "a" }]);
    answers.at(-1)!("later");
    expect(shown).toEqual(["a"]);
    queue.offer([]);
    expect(shown).toEqual(["a", "a"]);
  });

  it("offers a dropped host's on-screen prompt again once the host is back", () => {
    const shown: string[] = [];
    const answers: Array<(outcome: "done" | "retry" | "later") => void> = [];
    const queue = createApprovalPromptQueue<{ pairingLinkId: string; host: string }>(
      (prompt, answer) => {
        shown.push(prompt.pairingLinkId);
        answers.push(answer);
      },
    );

    queue.offer([{ pairingLinkId: "a", host: "mini" }]);
    queue.drop((prompt) => prompt.host === "mini");
    answers.at(-1)!("retry");
    expect(shown).toEqual(["a"]);
    queue.offer([{ pairingLinkId: "a", host: "mini" }]);
    expect(shown).toEqual(["a", "a"]);
  });

  it("drops a host's waiting prompts so they cannot hold up other hosts", () => {
    const shown: string[] = [];
    const answers: Array<(outcome: "done" | "retry" | "later") => void> = [];
    const queue = createApprovalPromptQueue<{ pairingLinkId: string; host: string }>(
      (prompt, answer) => {
        shown.push(prompt.pairingLinkId);
        answers.push(answer);
      },
    );

    queue.offer([
      { pairingLinkId: "a", host: "mini" },
      { pairingLinkId: "b", host: "mini" },
      { pairingLinkId: "c", host: "laptop" },
    ]);
    queue.drop((prompt) => prompt.host === "mini");
    answers.at(-1)!("done");
    expect(shown).toEqual(["a", "c"]);
    // A dropped host's request can be offered again once the host is back.
    expect(queue.known.has("b")).toBe(false);
  });
});
