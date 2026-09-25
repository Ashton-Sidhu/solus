<script lang="ts">
  import type { RootContent } from 'hast'
  import MarkdownNode from './MarkdownNode.svelte'
  import CodeSpan from '../ui/CodeSpan.svelte'
  import MarkdownAlert from '../ui/MarkdownAlert.svelte'
  import MarkdownParagraph from '../ui/MarkdownParagraph.svelte'
  import MarkdownListItem from '../ui/MarkdownListItem.svelte'
  import MarkdownImage from '../conversation/MarkdownImage.svelte'
  import MarkdownLink from '../conversation/MarkdownLink.svelte'
  import { alertKind, elementAttributes, nodeText, paragraphLocalVideoSource, paragraphMediaSource, taskCheckbox, voidElements, type MarkdownPolicy } from './lib/github-markdown'

  let { node, policy, parentTag = '', hideTaskCheckbox = false }: {
    node: RootContent
    policy: MarkdownPolicy
    parentTag?: string
    hideTaskCheckbox?: boolean
  } = $props()
  const element = $derived(node.type === 'element' ? node : null)
  const attributes = $derived(element ? elementAttributes(element) : {})
  const alert = $derived(element ? alertKind(element) : null)
  const media = $derived(element ? paragraphMediaSource(element) : '')
  // Only a local document can name a file on its host.
  const localVideo = $derived(element && policy === 'local' ? paragraphLocalVideoSource(element) : '')
  const checkbox = $derived(element ? taskCheckbox(element) : undefined)
</script>

{#snippet children()}
  {#if element}
    {#each element.children as child, index (index)}
      <MarkdownNode node={child} {policy} parentTag={element.tagName} hideTaskCheckbox={hideTaskCheckbox || !!checkbox} />
    {/each}
  {/if}
{/snippet}

{#if node.type === 'text'}
  {node.value}
{:else if element}
  {#if alert}
    <MarkdownAlert alertType={alert} content={children} />
  {:else if media}
    <MarkdownParagraph raw={media} />
  {:else if localVideo}
    <div class="my-3"><MarkdownImage href={localVideo} /></div>
  {:else if checkbox}
    <MarkdownListItem task checked={!!checkbox.properties.checked}>{@render children()}</MarkdownListItem>
  {:else if hideTaskCheckbox && element.tagName === 'input' && element.properties.type === 'checkbox'}
    <!-- The parent list item supplies the accessible, read-only checkbox. -->
  {:else if element.tagName === 'code' && parentTag !== 'pre'}
    <CodeSpan text={nodeText(element)} />
  {:else if element.tagName === 'img' && policy === 'local'}
    <MarkdownImage href={String(element.properties.src ?? '')} text={String(element.properties.alt ?? '')} title={typeof element.properties.title === 'string' ? element.properties.title : undefined} />
  {:else if element.tagName === 'a' && policy === 'local'}
    <MarkdownLink href={String(element.properties.href ?? '')} text={nodeText(element)}>{@render children()}</MarkdownLink>
  {:else if voidElements.has(element.tagName)}
    <svelte:element this={element.tagName} {...attributes} />
  {:else}
    <svelte:element this={element.tagName} {...attributes}>{@render children()}</svelte:element>
  {/if}
{/if}
