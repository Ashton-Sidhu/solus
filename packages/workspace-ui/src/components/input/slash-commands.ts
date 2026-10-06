import { NotebookPen as NotePencilIcon, Trash2 as TrashIcon, Bot as RobotIcon, KeyRound as KeyIcon } from "@lucide/svelte";
import type { Component } from "svelte";
import type { AgentId, IpcContext } from "@solus/contracts/types";
import type { HostApi } from "@solus/client-core/host-api";
import { AGENT_AUTH_COMMANDS } from "@solus/contracts/agent-auth";
import { agentAuthStore, seatProviderOf, seatsStore } from "../../contexts";
export { parseReviewCommand } from "@solus/contracts/review";

export const REVIEW_SLASH_COMMANDS = [
  "/review",
  "/review:working-tree",
  "/review:session",
  "/review:branch",
  "/review:pr",
] as const;

export interface SlashCommand {
  command: string;
  description: string;
  iconComponent?: Component;
  iconText?: string;
  insertTextOnSelect?: string;
  allowReadOnly?: boolean;
  /** The agents this command applies to; every agent when absent. */
  providers?: readonly AgentId[];
  run?: (ctx: SlashCommandRunContext) => void | Promise<void>;
}

export interface SlashCommandRunContext {
  api: HostApi;
  argument: string;
  ipcContext: IpcContext;
  /** The conversation the command runs in, absent for a draft. */
  serverId?: string;
  sessionId: string | null;
  provider: AgentId | null;
  clearCurrentConversation: () => void;
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
    command: '/compact',
    description: 'Compact the context of this session',
    providers: ['codex'],
    run: async ({ api, ipcContext, sessionId, argument, addSystemMessage, requestInputFocus }) => {
      try {
        if (argument.trim()) addSystemMessage('Use /compact without arguments.');
        else if (!sessionId) addSystemMessage('Send a first message before you compact this session.');
        else await api.compactSession(ipcContext);
      } catch (error) {
        addSystemMessage(`Could not compact this session: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        requestInputFocus();
      }
    },
  },
  {
    command: "/goal",
    description: "Set or view the persistent goal for this session",
  },
];

/** Whether a Solus command applies to a session on this agent. */
export function slashCommandAppliesTo(command: SlashCommand, provider: AgentId | null | undefined): boolean {
  return !command.providers || (!!provider && command.providers.includes(provider));
}

function agentAuthCommand(command: (typeof AGENT_AUTH_COMMANDS)[number]["command"]) {
  const entry = AGENT_AUTH_COMMANDS.find((each) => each.command === command)!;
  return {
    command,
    description: entry.description,
    iconComponent: KeyIcon,
    providers: entry.providers,
    ...("argumentHint" in entry && { insertTextOnSelect: `${command} ` }),
  };
}

/**
 * The provider CLIs keep their sign-ins for an interactive terminal, so Solus runs
 * them on the host in the caller's seat (docs/plans/agent-auth-commands.md). The
 * card that results stands in the conversation, so a draft cannot run them.
 */
function signInTarget(ctx: SlashCommandRunContext): { serverId: string; sessionId: string } | null {
  if (ctx.serverId && ctx.sessionId) return { serverId: ctx.serverId, sessionId: ctx.sessionId };
  ctx.addSystemMessage("Send a first message, then sign in from the conversation.");
  return null;
}

const AGENT_AUTH_SLASH_COMMANDS: SlashCommand[] = [
  {
    ...agentAuthCommand("/login"),
    run: (ctx) => {
      const target = signInTarget(ctx);
      const provider = seatProviderOf(ctx.provider);
      if (!target || !provider) return;
      seatsStore.requestSignIn(target.serverId, target.sessionId, provider);
    },
  },
  {
    ...agentAuthCommand("/design-login"),
    run: (ctx) => {
      const target = signInTarget(ctx);
      if (!target) return;
      void agentAuthStore.start(target.serverId, target.sessionId, { kind: "claude-design" }, "Claude Design");
    },
  },
  {
    ...agentAuthCommand("/mcp login"),
    run: (ctx) => {
      const server = ctx.argument.trim();
      const provider = seatProviderOf(ctx.provider);
      if (!server) {
        ctx.addSystemMessage("Name a server: /mcp login <server>");
        ctx.requestInputFocus();
        return;
      }
      const target = signInTarget(ctx);
      if (!target || !provider) return;
      const cwd = ctx.ipcContext.session.workingDirectory;
      void agentAuthStore.start(target.serverId, target.sessionId, { kind: "mcp", provider, server, cwd }, server);
    },
  },
  {
    ...agentAuthCommand("/mcp logout"),
    run: async (ctx) => {
      const server = ctx.argument.trim();
      const provider = seatProviderOf(ctx.provider);
      if (!server) {
        ctx.addSystemMessage("Name a server: /mcp logout <server>");
        ctx.requestInputFocus();
        return;
      }
      if (!ctx.serverId || !provider) return;
      const cwd = ctx.ipcContext.session.workingDirectory;
      ctx.addSystemMessage(await agentAuthStore.signOut(ctx.serverId, { kind: "mcp", provider, server, cwd }));
      ctx.requestInputFocus();
    },
  },
];

export function codexSlashCommands(provider: AgentId, includeSolusCommands: boolean): SlashCommand[] {
  return includeSolusCommands && provider === "codex" ? CODEX_SLASH_COMMANDS : [];
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    command: "/clear",
    description: "Clear current conversation",
    iconComponent: TrashIcon,
    allowReadOnly: true,
    run: ({ clearCurrentConversation }) => clearCurrentConversation(),
  },
  {
    command: "/update-agent-files",
    description: "Update relevant agent files with information.",
    iconComponent: RobotIcon,
    insertTextOnSelect: "/update-agent-files ",
    run: async ({ api, argument, ipcContext, addSystemMessage, requestInputFocus }) => {
      const result = await api.updateAgentFiles(ipcContext, argument);
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
  ...AGENT_AUTH_SLASH_COMMANDS,
];
