import type { ConversationController } from "@solus-mobile/features/conversation/conversation-controller";
import type { QueuedThreadMessage } from "../state/thread-outbox-model";
import { sessionPromptText } from "./review-prompt";

type HostComposerMessage = Pick<
  QueuedThreadMessage,
  "messageId" | "commandId" | "createdAt" | "text" | "context" | "dispatchMode"
>;

/** T3's enqueue completes at local persistence. Solus delivers the saved record independently. */
export function enqueueHostThreadMessage(
  controller: Pick<ConversationController, "submit">,
  message: HostComposerMessage,
  reportDeliveryError: (error: unknown) => void,
): Promise<void> | null {
  const { messageId, commandId, createdAt, context, dispatchMode } = message;
  const prompt = sessionPromptText(message.text, context);
  let submission: ReturnType<ConversationController["submit"]>;
  try {
    submission = controller.submit(prompt, {
      clientPromptId: messageId,
      pendingMessage: !context && !prompt.trimStart().startsWith("/")
        ? { messageId, commandId, createdAt }
        : undefined,
      delivery: dispatchMode === "steer" ? "steer" : dispatchMode === "queue" || dispatchMode === "restart" ? "queue" : undefined,
    });
  } catch (error) {
    reportDeliveryError(error);
    return null;
  }
  if (submission.messageId === null) {
    void submission.delivered.catch(reportDeliveryError);
    return null;
  }
  // Delivery includes the save. A save error belongs to the composer and must be reported only once.
  void submission.delivered.catch(async (error) => {
    if (await submission.saved.catch(() => false)) reportDeliveryError(error);
  });
  return submission.saved.then((saved) => {
    if (!saved) throw new Error("Check the attachments and try again.");
  });
}
