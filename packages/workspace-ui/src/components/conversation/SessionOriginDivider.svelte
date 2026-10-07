<script lang="ts">
  import { Bot as BotIcon } from "@lucide/svelte";
  import type { SessionOrigin } from "@solus/contracts/types";
  import TranscriptDivider from "./TranscriptDivider.svelte";

  /**
   * The first line of a session that an agent on another host started
   * (docs/plans/cross-host-sessions.md). The host is named by its label; the
   * session that started it lives on that host.
   */
  let { origin }: { origin: SessionOrigin } = $props();
</script>

{#snippet originGlyph()}<BotIcon size={10} />{/snippet}

{#snippet originHost()}{origin.hostLabel}{/snippet}

<TranscriptDivider glyph={originGlyph} title={originHost} testid="session-origin" skipMotion>
  Started by an agent on
</TranscriptDivider>
