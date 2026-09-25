import { getWorkspaceContext, getSettingsContext, getClientShellContext } from '../../../contexts';
import type { Prompt, PromptDelivery, RunConfig, PluginCommandsResult } from '@solus/contracts/types';
import type PromptEditor from '../../ui/PromptEditor.svelte';
import { SLASH_COMMANDS, type SlashCommand } from '../slash-commands';
import { createGoalCommand } from './goal-command';
import { loadPromptHistory, savePromptToHistory } from './prompt-history';
import { pendingPlanForPrompt } from './pending-plan';
import { pendingQuestionForPrompt, answersForQuestionNote } from './pending-question';
import { requestInputFocus } from '../../../lib/inputFocus';
import { isMac } from '../../../lib/keybindings/match';
import { toasts } from '../../../lib/toasts';
import { LOCAL_SERVER_ID } from '@solus/client-core/server-registry';
import { hostPolicy } from '@solus/client-core/host-policy';
import { serverConnections } from '@solus/client-core/server-connections';
import {
  clipboardMedia,
  isLargePaste,
  pastedImageAttachment,
  pastedTextFile,
  readFileDataUrl,
  uploadPastedImage,
} from './attachment-upload';
import { videoMimeType } from '@solus/contracts/video';
import { attachmentUploads, uploadFileObjects } from './attachment-uploads.svelte';

interface ComposerCommandOptions {
  isReadOnly: boolean;
  isConnecting: boolean;
  isTouch: boolean;
  run?: RunConfig;
  prompt: Prompt;
  sessionId: string | null;
  targetTabId?: string;
  draftId?: string;
  composerCwd: string;
  pluginCommands: PluginCommandsResult;
  onDispatch?: (text: string, delivery: PromptDelivery) => boolean;
  onDispatchInBackground?: (text: string) => boolean;
  onSent?: () => void;
  editor: ReturnType<typeof PromptEditor> | null;
  refocusComposer: () => void;
}

/**
 * The "paste this literally" chord. A ClipboardEvent carries no modifier
 * state, so a paste large enough to be filed can only learn the user meant it
 * from the keydown that produced it.
 */
function isPasteAsTextChord(e: KeyboardEvent): boolean {
  if (!e.shiftKey) return false
  if (!(e.metaKey || e.ctrlKey)) return false
  return e.key.toLowerCase() === "v"
}

/** Owns send, slash commands, history recall, and paste for one prompt target. */
export function useComposerCommands(getOptions: () => ComposerCommandOptions) {
  const session = getWorkspaceContext();
  const theme = getSettingsContext();
  const clientShell = getClientShellContext();
  // ─── Prompt history ───

  let promptHistory = $state<string[]>(loadPromptHistory(localStorage));
  let historyIndex = $state(-1);
  let savedInput = "";
  // Set by the paste-as-text shortcut on the keydown that precedes the paste.
  // A ClipboardEvent carries no modifier state, so the intent has to be caught
  // on the way in and read by the paste that follows it in the same gesture.
  let pasteAsTextRequested = false;

  function resetHistoryNavigation() {
    historyIndex = -1;
    savedInput = "";
  }

  function solusCommandFromInput(
    value: string,
  ): { cmd: SlashCommand; argument: string } | null {
    for (const cmd of SLASH_COMMANDS) {
      if (!value.startsWith(cmd.command)) continue;
      const rest = value.slice(cmd.command.length);
      if (rest && !/^[ \t\n]/.test(rest)) continue;
      return { cmd, argument: rest ? rest.slice(1) : "" };
    }
    return null;
  }

  function executeCommand(cmd: SlashCommand, argument = "") {
    const { isReadOnly, run, targetTabId, composerCwd, refocusComposer } = getOptions();
    if (isReadOnly && !cmd.allowReadOnly) return;
    void cmd.run?.({
      api: session.apiForRun(run),
      argument,
      // A command run from a draft's composer has no conversation to clear or
      // to speak into; it still runs, against the project the draft points at.
      ipcContext: targetTabId
        ? session.ctxFor(targetTabId)
        : session.ctxForDirectory(composerCwd),
      clearCurrentConversation: () => {
        if (targetTabId) {
          session.clearTabToDraft(targetTabId, "keybinding");
        } else {
          session.drafts.openSessionDraft({ via: "keybinding" });
        }
      },
      addSystemMessage: (message) => {
        if (targetTabId) session.addSystemMessage(message, targetTabId);
      },
      appendGlobalInstructions: (text) => {
        const existing = theme.extraInstructions.trim();
        theme.update({
          extraInstructions: existing ? `${existing}\n\n${text}` : text,
        });
      },
      requestInputFocus: refocusComposer,
    });
  }

  function clearComposer() {
    const { prompt, editor: composerEl } = getOptions();
    prompt.text = "";
    composerEl?.clearEditor();
  }

  const handleGoalCommand = createGoalCommand({
    isReadOnly: () => getOptions().isReadOnly,
    targetTabId: () => getOptions().targetTabId,
    sendPrompt,
    clearComposer,
    refocusComposer: () => getOptions().refocusComposer(),
  });

  // A Solus built-in command was picked from the menu. The composer has already
  // cleared its completion state; here we either insert its template text or run
  // it outright.
  function handleSolusCommand(cmd: SlashCommand) {
    const { isReadOnly, prompt, refocusComposer, editor: composerEl } = getOptions();
    if (isReadOnly) return;
    if (cmd.insertTextOnSelect) {
      const text = cmd.insertTextOnSelect;
      prompt.text = text;
      composerEl?.setValueAndCursor(text);
      refocusComposer();
      return;
    }
    prompt.text = "";
    composerEl?.clearEditor();
    executeCommand(cmd);
  }

  // ─── Core input handlers ───

  function sendPrompt(
    text: string,
    options: {
      refocus?: boolean;
      delivery?: PromptDelivery;
      background?: boolean;
    } = {},
  ): boolean {
    const { prompt, sessionId, targetTabId, onDispatch, onDispatchInBackground, onSent, refocusComposer, editor: composerEl } = getOptions();
    const { attachments } = prompt;
    const sess = sessionId ? session.sessions.byId[sessionId] : undefined;
    const pendingPlan = pendingPlanForPrompt(sess, session.planStore.plans);
    const pendingQuestion = pendingQuestionForPrompt(sess);
    const fallbackText = attachments.some(
      (attachment) =>
        attachment.type === "design-selection" &&
        Boolean(attachment.designData?.browserMarks?.length),
    )
      ? "Please address these UI concerns"
      : "See attached files";
    let accepted = true;
    if (options.background && onDispatchInBackground) {
      // A draft only, so none of the session-shaped branches below can apply:
      // there is no held plan or question behind a composer with no session.
      accepted = onDispatchInBackground(text || fallbackText);
    } else if (pendingPlan) {
      // Match the plan surface's Revise action: answer the held ExitPlanMode
      // request, keep the provider in plan mode, and send this text as feedback
      // instead of letting it become an ordinary queued prompt.
      void session.rejectPlan(pendingPlan.id, text || fallbackText);
    } else if (pendingQuestion && text && targetTabId) {
      // Match the question card's free-text answer. Responding releases the held
      // provider turn; queuing this as a normal prompt would leave it blocked.
      session.controls.respondQuestion(
        targetTabId,
        pendingQuestion.questionId,
        answersForQuestionNote(pendingQuestion, text),
      );
    } else if (onDispatch) {
      accepted = onDispatch(
        text || fallbackText,
        options.delivery ?? "steer",
      );
    } else {
      accepted = session.dispatch.sendMessage(
        text || fallbackText,
        undefined,
        targetTabId,
        options.delivery,
      );
    }

    if (!accepted) {
      if (options.refocus !== false) refocusComposer();
      return false;
    }

    promptHistory = savePromptToHistory(localStorage, text);
    prompt.text = "";
    resetHistoryNavigation();
    composerEl?.clearEditor();
    onSent?.();

    if (options.refocus !== false) {
      // A session keeps its composer after Send. Focus it in this gesture so
      // touch keyboards stay open and another pane cannot receive the focus.
      // Drafts can navigate to a new composer and still need workspace routing.
      if (sessionId) composerEl?.focus();
      else refocusComposer();
    }
    return true;
  }

  /** The same two calls `conversation.interrupt` makes: the tab lets go of the
   *  turn locally, and the host is told to stop the provider. */
  function stopRun() {
    const { sessionId, targetTabId } = getOptions();
    if (!targetTabId) return;
    session.controls.interruptTabSession(targetTabId);
    void session
      .apiFor(targetTabId)
      .stopSession(session.ctxFor(targetTabId).session.sessionId);
    requestInputFocus({ tabId: targetTabId });
  }

  function handleSend(
    delivery: PromptDelivery = "steer",
    options: { refocus?: boolean; background?: boolean } = {},
  ): boolean {
    const { isReadOnly, isConnecting, prompt, refocusComposer, pluginCommands, editor: composerEl } = getOptions();
    const inputText = prompt.text;
    const { attachments, planRefs, workRefs, sessionRefs } = prompt;
    const providerSkills = [...pluginCommands.project, ...pluginCommands.global].filter(command => command.kind === 'skill');
    if (isReadOnly) return false;
    let text = inputText.trim();
    if (
      !text &&
      attachments.length === 0 &&
      planRefs.length === 0 &&
      workRefs.length === 0 &&
      sessionRefs.length === 0
    )
      return false;
    if (isConnecting) return false;
    const uploadBlocker = attachmentUploads.sendBlocker(attachments);
    if (uploadBlocker) {
      toasts.info(uploadBlocker);
      refocusComposer();
      return false;
    }

    if (/^\/goal(?:\s|$)/.test(text)) {
      void handleGoalCommand(text.slice("/goal".length));
      return false;
    }

    // Mobile keyboards sometimes autocorrect the skill name and insert it as
    // plain text before the slash command (e.g. "ui /ui rest"). Strip it.
    for (const skill of providerSkills) {
      const prefix = skill.name + " /" + skill.name;
      if (text.startsWith(prefix)) {
        text = text.slice(skill.name.length + 1);
        break;
      }
    }

    const solusCommand = solusCommandFromInput(inputText);
    if (solusCommand) {
      prompt.text = "";
      composerEl?.clearEditor();
      executeCommand(solusCommand.cmd, solusCommand.argument);
      refocusComposer();
      return false;
    }

    return sendPrompt(text, {
      delivery,
      refocus: options.refocus,
      background: options.background,
    });
  }

  function navigateHistory(delta: -1 | 1) {
    const { prompt, editor: composerEl } = getOptions();
    const inputText = prompt.text;
    // The workspace, action surfaces, and split panes keep separate composers mounted.
    // Ctrl+C can refocus a composer other than the one that sent the prompt, so
    // refresh from the shared durable history before recall.
    if (historyIndex === -1) {
      promptHistory = loadPromptHistory(localStorage);
    }
    if (delta === -1) {
      if (historyIndex === -1) {
        savedInput = inputText;
        historyIndex = promptHistory.length - 1;
      } else if (historyIndex > 0) {
        historyIndex--;
      }
    } else {
      if (historyIndex < promptHistory.length - 1) {
        historyIndex++;
      } else {
        historyIndex = -1;
      }
    }
    const next = historyIndex >= 0 ? promptHistory[historyIndex] : savedInput;
    prompt.text = next;
    composerEl?.setValueAndCursor(next);
  }

  // Fired by the composer only when no autocomplete menu consumed the event.
  function handleKeyDown(e: KeyboardEvent) {
    const { isTouch, run, onDispatchInBackground, editor: composerEl } = getOptions();
    // Not preventDefault'd: the browser still performs the paste, this only
    // tells the paste handler to leave it inline.
    if (isPasteAsTextChord(e)) pasteAsTextRequested = true;
    if (
      e.key === "ArrowUp" &&
      !e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey
    ) {
      const atStart = composerEl?.isCaretAtStart() ?? false;
      if ((atStart || historyIndex !== -1) && promptHistory.length > 0) {
        e.preventDefault();
        navigateHistory(-1);
        return;
      }
    }

    if (e.key === "ArrowDown" && historyIndex !== -1) {
      e.preventDefault();
      navigateHistory(1);
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // ⌘Enter (Ctrl+Enter off macOS) starts the session in the background and
      // leaves this composer where it is, so a run of prompts can be fired off
      // one after another. Same `mod` key every other Solus binding uses.
      const modifier = isMac ? e.metaKey : e.ctrlKey;
      const otherModifier = isMac ? e.ctrlKey : e.metaKey;
      const background =
        modifier && !e.altKey && !otherModifier && !!onDispatchInBackground;
      const delivery: PromptDelivery = e.altKey ? "queue" : "steer";
      // On iOS the soft keyboard holds the word under the caret in flight, and
      // clearing the composer inside this synchronous keydown is undone by it:
      // iOS defers the settle blur `clearEditor` issues while it is still
      // processing the key, so the word is put straight back and the bar never
      // clears. The send button clears cleanly because a click runs in a fresh
      // task where that blur takes effect. Hand the send to a fresh task on
      // touch so Enter behaves the same; leave the synchronous path on desktop.
      if (isTouch) {
        setTimeout(() => handleSend(delivery, { background }), 0);
      } else {
        handleSend(delivery, { background });
      }
    }
  }

  function handleEditorChange(md: string) {
    const { isReadOnly, prompt } = getOptions();
    if (isReadOnly) return;
    prompt.text = md;
    if (historyIndex !== -1) resetHistoryNavigation();
  }

  /**
   * The pasted text when it should be filed rather than typed, else "".
   *
   * Always consumes the paste-as-text request, whether or not this paste turns
   * out to be foldable — the shortcut answers for the gesture that followed it
   * and must not carry into the next ordinary paste.
   */
  function foldableText(clipboard: DataTransfer, hasImages: boolean): string {
    const wasAskedForText = pasteAsTextRequested;
    pasteAsTextRequested = false;
    // An image paste is already an attachment, and a clipboard carrying both is
    // the image's paste — its text half is a fallback rendering of the same
    // thing, so filing it too would attach the same content twice.
    if (hasImages || wasAskedForText) return "";
    const text = clipboard.getData("text/plain");
    return isLargePaste(text) ? text : "";
  }

  /**
   * File a large paste instead of typing it. Reuses the ordinary upload path,
   * so the text lands beside any other attachment and the agent opens it on
   * demand rather than reading all of it into the window up front.
   *
   * A host that cannot mint an attachment path has no fallback for a file — an
   * image can ride along as prompt content, a `.txt` cannot — so there the
   * paste stays inline and behaves exactly as it did before.
   */
  async function foldPasteIntoAttachment(text: string): Promise<void> {
    const { run, prompt, targetTabId, draftId, editor: composerEl } = getOptions();
    const serverId = run?.serverId ?? LOCAL_SERVER_ID;
    const composerSourceId = targetTabId ?? draftId;
    const ctx = composerSourceId
      ? session.ctxFor(composerSourceId)
      : session.ctxForDirectory(run?.workingDirectory ?? session.ctx.session.workingDirectory);
    try {
      const capabilities = await serverConnections.capabilitiesFor(serverId);
      if (capabilities.attachUpload !== true) {
        composerEl?.insertTranscript(text);
        return;
      }
      const [attachment] = await uploadFileObjects(
        session.apiForRun(run),
        ctx,
        serverId,
        [pastedTextFile(text)],
      );
      if (attachment) prompt.attachments.push(attachment);
      else composerEl?.insertTranscript(text);
    } catch (error) {
      // Never lose the paste: if filing it failed, it still belongs in the
      // composer where the user put it.
      composerEl?.insertTranscript(text);
      toasts.error(error instanceof Error ? error.message : "Couldn't attach pasted text");
    }
  }

  async function handlePaste(e: ClipboardEvent) {
    const { isReadOnly, run, prompt, targetTabId, draftId } = getOptions();
    if (isReadOnly) return;
    const clipboard = e.clipboardData;
    if (!clipboard) return;
    const blobs = clipboardMedia(clipboard);
    const foldable = foldableText(clipboard, blobs.length > 0);
    if (foldable) {
      e.preventDefault();
      await foldPasteIntoAttachment(foldable);
      return;
    }
    if (blobs.length === 0) return;
    e.preventDefault();

    const api = session.apiForRun(run);
    // Addressed by this composer's own source. `ctxForDirectory` falls back to
    // the active tab, which for a draft names an unrelated session — the upload
    // would be filed under that conversation, or refused outright when no tab
    // is mounted at all, which is the ordinary state of a phone.
    const composerSourceId = targetTabId ?? draftId;
    const ctx = composerSourceId
      ? session.ctxFor(composerSourceId)
      : session.ctxForDirectory(run?.workingDirectory ?? session.ctx.session.workingDirectory);
    const serverId = run?.serverId ?? LOCAL_SERVER_ID;
    // One image failing — too large, say — must not drop the rest of the paste,
    // so each is attached on its own and reports its own error.
    for (const blob of blobs) {
      try {
        // A video is a file, never pasted image content: it streams to the
        // host and its chip shows the upload.
        if (videoMimeType({ name: blob.name, mimeType: blob.type })) {
          if ((await serverConnections.capabilitiesFor(serverId)).attachUpload !== true) {
            throw new Error("Update the host to attach videos.");
          }
          prompt.attachments.push(...await uploadFileObjects(api, ctx, serverId, [blob]));
          continue;
        }
        const dataUrl = await readFileDataUrl(blob);
        const capabilities = await serverConnections.capabilitiesFor(serverId);
        const attachment = clientShell.supportsLocalAttachments && hostPolicy.isClientMachine(serverId)
          ? await api.pasteImage(dataUrl, ctx)
          : capabilities.attachUpload === true
            ? await uploadPastedImage(api, ctx, serverId, dataUrl)
            : pastedImageAttachment(dataUrl, serverId);
        if (attachment) prompt.attachments.push(attachment);
      } catch (error) {
        toasts.error(error instanceof Error ? error.message : "Couldn't attach pasted image");
      }
    }
  }
  return { sendPrompt, handleSend, handleSolusCommand, stopRun, handleKeyDown, handleEditorChange, handlePaste };
}
