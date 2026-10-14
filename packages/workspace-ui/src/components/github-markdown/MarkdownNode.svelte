<script lang="ts">
  import type { RootContent } from 'hast'
  import MarkdownNode from './MarkdownNode.svelte'
  import CodeSpan from '../ui/CodeSpan.svelte'
  import MarkdownAlert from '../ui/MarkdownAlert.svelte'
  import MarkdownParagraph from '../ui/MarkdownParagraph.svelte'
  import MarkdownListItem from '../ui/MarkdownListItem.svelte'
  import MarkdownImage from '../conversation/MarkdownImage.svelte'
  import MarkdownLink from '../conversation/MarkdownLink.svelte'
  import MermaidBlock from '../conversation/MermaidBlock.svelte'
  import PersonMention from '../mentions/PersonMention.svelte'
  import SignedGithubMedia from './SignedGithubMedia.svelte'
  import { githubMediaFetchUrl } from '@solus/contracts/github-media'
  import { getGithubMediaHost, githubMediaSources } from './lib/github-media.svelte'
  import { alertKind, elementAttributes, mermaidFenceSource, nodeText, paragraphLocalVideoSource, paragraphMediaSource, personMentionOf, taskCheckbox, voidElements, type MarkdownPolicy } from './lib/github-markdown'

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
  const mermaid = $derived(element ? mermaidFenceSource(element) : null)
  // Only a local document stores mentions of organization members.
  const mention = $derived(element && policy === 'local' ? personMentionOf(element) : null)
  // A pull request surface signs GitHub media on its host, so a private
  // repository's images and videos show.
  const mediaHost = getGithubMediaHost()
  const mediaServerId = $derived(policy === 'remote' ? (mediaHost?.() ?? null) : null)
  const imageSource = $derived(element?.tagName === 'img' ? String(element.properties.src ?? '') : '')
  const signsImage = $derived(!!mediaServerId && !!imageSource && githubMediaFetchUrl(imageSource) !== null)
  const signsMedia = $derived(!!mediaServerId && !!media && githubMediaFetchUrl(media) !== null)
  // The signed copy did not load: show the author's URL instead.
  function signedImageFailed(serverId: string, src: string | null) {
    if (src && src !== imageSource) githubMediaSources.refuse(serverId, imageSource)
  }
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
  {:else if mermaid !== null}
    <MermaidBlock text={mermaid} />
  {:else if media && signsMedia && mediaServerId}
    <SignedGithubMedia serverId={mediaServerId} source={media}>
      {#snippet withSource(src)}
        {#if src}<MarkdownParagraph raw={media} playbackSrc={src} />{/if}
      {/snippet}
    </SignedGithubMedia>
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
  {:else if signsImage && mediaServerId}
    {@const serverId = mediaServerId}
    <SignedGithubMedia {serverId} source={imageSource}>
      {#snippet withSource(src)}
        <img
          {...attributes}
          src={src ?? undefined}
          onerror={() => signedImageFailed(serverId, src)}
        />
      {/snippet}
    </SignedGithubMedia>
  {:else if mention}
    <PersonMention {mention} />
  {:else if element.tagName === 'a' && policy === 'local'}
    <MarkdownLink href={String(element.properties.href ?? '')} text={nodeText(element)}>{@render children()}</MarkdownLink>
  {:else if voidElements.has(element.tagName)}
    <svelte:element this={element.tagName} {...attributes} />
  {:else}
    <svelte:element this={element.tagName} {...attributes}>{@render children()}</svelte:element>
  {/if}
{/if}
