<script lang="ts">
  import MarkdownNode from './MarkdownNode.svelte'
  import { parseGithubMarkdown, type MarkdownPolicy } from './lib/github-markdown'

  // `lineBreaks`: a single newline breaks the line, as GitHub renders a pull
  // request body or comment.
  let { source, policy = 'remote', lineBreaks = false }: { source: string; policy?: MarkdownPolicy; lineBreaks?: boolean } = $props()
  const tree = $derived(parseGithubMarkdown(source, policy, lineBreaks))
</script>

{#each tree.children as node, index (index)}
  <MarkdownNode {node} {policy} />
{/each}
