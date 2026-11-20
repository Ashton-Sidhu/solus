import { argumentHint, promptsBesideCommands } from "@solus/client-core/integration-prompts";
import type { IntegrationPrompt, IntegrationPromptSignIn } from "@solus/contracts/integrations/prompts";
import { GLYPH } from "./kinds";
import type { MenuItem } from "./rows";

/**
 * The `/` menu's MCP band (docs/plans/mcp-first-class.md §10): one row for
 * each MCP prompt, with its description and argument hint, then one row for
 * each server whose prompts wait on the person's sign-in. A prompt whose
 * command a Solus or provider command already has is left out: the command
 * wins, so a typed line always means one thing.
 */
export function mcpPromptItems(
  list: { prompts: readonly IntegrationPrompt[]; signIn: readonly IntegrationPromptSignIn[] },
  /** The titles of the menu's other commands, without the leading `/`. */
  commandTitles: readonly string[],
): MenuItem[] {
  const prompts = promptsBesideCommands(list.prompts, commandTitles.map((title) => `/${title}`));
  return [
    ...prompts.map((prompt): MenuItem => ({
      id: `mcp:${prompt.command}`,
      title: prompt.command.slice(1),
      meta: prompt.description ?? prompt.title ?? prompt.integrationName,
      when: argumentHint(prompt),
      icon: GLYPH.cmd,
      mono: true,
      monoMeta: false,
      token: { kind: "slash", command: prompt.command },
      mcpPrompt: { kind: "prompt", prompt },
    })),
    ...list.signIn.map((server): MenuItem => ({
      id: `mcp-sign-in:${server.integrationId}`,
      title: `${server.slug}:`,
      meta: server.needs === "environment"
        ? `Give the values of ${server.integrationName} to use its prompts`
        : `Sign in to ${server.integrationName} to use its prompts`,
      when: server.needs === "environment" ? "values" : "sign in",
      icon: GLYPH.cmd,
      mono: true,
      monoMeta: false,
      token: { kind: "slash", command: `/${server.slug}:` },
      mcpPrompt: { kind: "sign-in", server },
    })),
  ];
}
