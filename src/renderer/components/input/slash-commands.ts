import { NotePencilIcon, TrashIcon, RobotIcon } from "phosphor-svelte";
import type { Component } from "svelte";
import type { AgentId, IpcContext } from "../../../shared/types";

export interface SlashCommand {
  command: string;
  description: string;
  iconComponent?: Component;
  iconText?: string;
  insertTextOnSelect?: string;
  allowReadOnly?: boolean;
  run?: (ctx: SlashCommandRunContext) => void | Promise<void>;
}

export interface SlashCommandRunContext {
  argument: string;
  ipcContext: IpcContext;
  clearTab: () => void;
  addSystemMessage: (message: string) => void;
  appendGlobalInstructions: (text: string) => void;
  requestInputFocus: () => void;
}

export interface CategorizedSlashCommands {
  solus: SlashCommand[];
  codex: SlashCommand[];
  claudeCode: SlashCommand[];
  global: SlashCommand[];
  project: SlashCommand[];
}

/** Codex app-server does not report its TUI built-ins through skills/list.
 * Keep the small set Solus handles itself explicit rather than pretending it
 * was discovered from the provider. */
export const CODEX_SLASH_COMMANDS: SlashCommand[] = [
  {
    command: "/goal",
    description: "Set or view the persistent goal for this session",
  },
];

export function codexSlashCommands(provider: AgentId, includeSolusCommands: boolean): SlashCommand[] {
  return includeSolusCommands && provider === "codex" ? CODEX_SLASH_COMMANDS : [];
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    command: "/clear",
    description: "Clear conversation history",
    iconComponent: TrashIcon,
    allowReadOnly: true,
    run: ({ clearTab }) => clearTab(),
  },
  {
    command: "/update-agent-files",
    description: "Update relevant agent files with information.",
    iconComponent: RobotIcon,
    insertTextOnSelect: "/update-agent-files ",
    run: async ({ argument, ipcContext, addSystemMessage, requestInputFocus }) => {
      const result = await window.solus.updateAgentFiles(ipcContext, argument);
      if (result.success) {
        addSystemMessage(
          `Updated ${result.files?.map((file) => file.split("/").pop()).join(" and ") ?? "agent files"}.`,
        );
      } else {
        addSystemMessage(
          `Failed to update agent files: ${result.err ?? "Unknown error"}`,
        );
      }
      requestInputFocus();
    },
  },
  {
    command: "/update-global-instructions",
    description: "Append information to global extra instructions.",
    iconComponent: NotePencilIcon,
    insertTextOnSelect: "/update-global-instructions ",
    run: ({ argument, addSystemMessage, appendGlobalInstructions, requestInputFocus }) => {
      const text = argument.trim();
      if (!text) {
        addSystemMessage("Failed to update global instructions: No content provided");
        requestInputFocus();
        return;
      }
      appendGlobalInstructions(text);
      addSystemMessage("Updated global extra instructions.");
      requestInputFocus();
    },
  },
];
