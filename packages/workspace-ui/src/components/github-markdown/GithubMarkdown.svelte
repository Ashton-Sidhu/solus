<script lang="ts">
  import MarkdownNode from './MarkdownNode.svelte'
  import { parseGithubMarkdown, type MarkdownPolicy } from './lib/github-markdown'

  let { source, policy = 'remote' }: { source: string; policy?: MarkdownPolicy } = $props()
  const tree = $derived(parseGithubMarkdown(source, policy))
</script>

{#each tree.children as node, index (index)}
  <MarkdownNode {node} {policy} />
{/each}
