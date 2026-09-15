<script lang="ts">
  import SvelteMarkdown from '@humanspeak/svelte-markdown';
  import CodeBlock from '../../../packages/workspace-ui/src/components/ui/CodeBlock.svelte';
  import { assistantMarkdownExtensions } from '../../../packages/workspace-ui/src/components/conversation/lib/assistant-markdown';
  let source = $state('A finished paragraph.\n\n```typescript\n/* a multiline comment\ncontinued */\nconst answer = 42;\n```\n\n');
  let live = $state(true);
  const renderers = { code: CodeBlock };
  export function update(text: string, streaming = true) { source = text; live = streaming; }
</script>
<div class="response-markdown prose-cloud prose-reading prose-transcript prose-transcript-main" data-streaming={live ? '' : undefined}>
  <SvelteMarkdown {source} streaming {renderers} extensions={assistantMarkdownExtensions(source)} />
</div>
