<script lang="ts">
  /**
   * One place a found server is in, as the logo of the tool whose config file
   * has it (docs/plans/mcp-first-class.md §8.6): Claude in its own colour, the
   * OpenAI mark for Codex, the offline Iconify marks of Cursor and VS Code,
   * and a server glyph for a port of the host. The label names the file and
   * which agent loads it, on hover and for a screen reader. A file that turns
   * the server off dims its logo.
   */
  import Icon from "@iconify/svelte";
  import { Server } from "@lucide/svelte";
  import type { FoundSource } from "@solus/contracts/integrations/found-server-labels";
  import ClaudeIcon from "../ClaudeIcon.svelte";
  import ProviderMark from "../ui/ProviderMark.svelte";
  import OpenAIBlossom from "../pickers/OpenAIBlossom.svelte";
  import { ensureIconCollections } from "../../lib/iconify";
  import { APP_LOGOS } from "./lib/app-logos";

  let { source }: { source: FoundSource } = $props();

  ensureIconCollections();
</script>

<span class="flex size-3.5 shrink-0 items-center justify-center text-foreground {source.isTurnedOff ? 'opacity-40' : ''}" role="img" aria-label={source.label} title={source.label}>
  {#if source.kind === "claude-json" || source.kind === "mcp-json" || source.kind === "claude-desktop"}
    <span class="flex text-(--brand-claude)"><ClaudeIcon size={14} /></span>
  {:else if source.kind === "codex-config"}
    <OpenAIBlossom size={14} fill="currentColor" />
  {:else if source.kind === "antigravity-config"}
    <ProviderMark mark="antigravity" size={14} transparent />
  {:else if source.kind === "cursor" || source.kind === "vscode"}
    <Icon icon={APP_LOGOS.get(source.kind) ?? ""} width={14} height={14} />
  {:else}
    <Server size={14} class="text-(--solus-text-secondary)" />
  {/if}
</span>
