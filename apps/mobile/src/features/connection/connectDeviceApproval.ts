import type { PairApprovalRequest } from "@solus/contracts/add-machine";
import { msg } from "gt-react-native";

import { m } from "../../i18n/messages";

export interface ConnectDeviceApprovalPrompt {
  /** The host and the request, so two hosts' requests never share a prompt. */
  readonly pairingLinkId: string;
  readonly requestId: string;
  readonly title: string;
  readonly message: string;
}

/**
 * Approval requests (docs/plans/add-machine-card.md) that have not been shown
 * yet, oldest first. Solus asks for the same thing T3 Connect asks for: a
 * machine wants to pair, and the person compares the check code first.
 */
export function pairApprovalPrompts(input: {
  readonly hostId: string;
  readonly hostLabel: string;
  readonly approvals: ReadonlyArray<PairApprovalRequest>;
  readonly shownIds: ReadonlySet<string>;
  readonly now: number;
}): ReadonlyArray<ConnectDeviceApprovalPrompt> {
  // Hermes lacks toSorted: `filter` makes the copy that `sort` orders.
  return input.approvals
    .filter(
      (request) =>
        request.expiresAt > input.now &&
        !input.shownIds.has(`${input.hostId}:${request.requestId}`),
    )
    .sort((left, right) => left.requestedAt - right.requestedAt)
    .map((request) => ({
      pairingLinkId: `${input.hostId}:${request.requestId}`,
      requestId: request.requestId,
      title: m(msg("Approve this machine?")),
      message: m(
        msg(
          "{device} at {address} wants to pair with {host}. It shows check code {code}. Approve it only if that code matches.",
          {
            device: request.deviceLabel,
            address: request.fromAddress,
            host: input.hostLabel,
            code: request.checkCode,
          },
        ),
      ),
    }));
}

/**
 * Shows approval prompts one at a time: an Android alert replaces the one on screen, which
 * would drop an unanswered request. A prompt answered with "retry" goes back to the front;
 * "later" puts it back without showing anything until the next offer.
 */
export function createApprovalPromptQueue<P extends { readonly pairingLinkId: string }>(
  present: (prompt: P, answer: (outcome: "done" | "retry" | "later") => void) => void,
) {
  const known = new Set<string>();
  const waiting: P[] = [];
  let showing: { readonly prompt: P; dropped: boolean } | null = null;
  const next = () => {
    if (showing) return;
    const prompt = waiting.shift();
    if (prompt === undefined) return;
    const current = { prompt, dropped: false };
    showing = current;
    let answered = false;
    present(prompt, (outcome) => {
      if (answered) return;
      answered = true;
      showing = null;
      // A dropped prompt is forgotten, so its host can offer it again when it comes back.
      if (outcome !== "done" && !current.dropped) waiting.unshift(prompt);
      if (outcome !== "later") next();
    });
  };
  return {
    known: known as ReadonlySet<string>,
    /** Forgets waiting prompts that match, such as a host that went away. */
    drop(matches: (prompt: P) => boolean) {
      if (showing && matches(showing.prompt)) {
        showing.dropped = true;
        known.delete(showing.prompt.pairingLinkId);
      }
      for (let index = waiting.length - 1; index >= 0; index--) {
        const prompt = waiting[index]!;
        if (!matches(prompt)) continue;
        waiting.splice(index, 1);
        known.delete(prompt.pairingLinkId);
      }
    },
    offer(prompts: ReadonlyArray<P>) {
      // Also re-shows a prompt deferred because another dialog took the screen.
      for (const prompt of prompts) {
        if (known.has(prompt.pairingLinkId)) continue;
        known.add(prompt.pairingLinkId);
        waiting.push(prompt);
      }
      next();
    },
  };
}
