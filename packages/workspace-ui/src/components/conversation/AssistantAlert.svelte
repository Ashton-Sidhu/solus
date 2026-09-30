<script lang="ts">
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import {
    Info as InfoIcon,
    Lightbulb as LightbulbIcon,
    MessageSquareWarning as ImportantIcon,
    OctagonAlert as CautionIcon,
    TriangleAlert as WarningIcon,
  } from "@lucide/svelte";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import CodeSpan from "../ui/CodeSpan.svelte";
  import FencedBlock from "./FencedBlock.svelte";
  import MarkdownLink from "./MarkdownLink.svelte";
  import type { AlertType } from "./lib/markdown-extensions";

  /** A GitHub alert (`> [!NOTE]`) in a reply: a tinted rule and a titled
   *  heading. The body is ordinary reply markdown. */
  let { alertType, text }: { alertType: AlertType; text: string } = $props();

  const markdownRenderers = { code: FencedBlock, codespan: CodeSpan, link: MarkdownLink };
  const alerts = {
    note: { title: "Note", icon: InfoIcon, rule: "border-blue-500/70", tint: "text-blue-600 dark:text-blue-400" },
    tip: { title: "Tip", icon: LightbulbIcon, rule: "border-emerald-500/70", tint: "text-emerald-600 dark:text-emerald-400" },
    important: { title: "Important", icon: ImportantIcon, rule: "border-purple-500/70", tint: "text-purple-600 dark:text-purple-400" },
    warning: { title: "Warning", icon: WarningIcon, rule: "border-amber-500/70", tint: "text-amber-600 dark:text-amber-500" },
    caution: { title: "Caution", icon: CautionIcon, rule: "border-red-500/70", tint: "text-red-600 dark:text-red-400" },
  } satisfies Record<AlertType, { title: string; icon: typeof InfoIcon; rule: string; tint: string }>;
  const alert = $derived(alerts[alertType]);
</script>

<div class="my-2.5 border-l-2 pl-3 {alert.rule}" role="note">
  <p class="!mb-0.5 flex items-center gap-1.5 font-medium {alert.tint}">
    <alert.icon class="size-3.5 shrink-0" aria-hidden="true" />
    {alert.title}
  </p>
  <div class="[&>:last-child]:!mb-0">
    <SvelteMarkdown source={text} renderers={markdownRenderers} sanitizeUrl={markdownSanitizeUrl} />
  </div>
</div>
