<script lang="ts">
  import { untrack, type Snippet } from 'svelte'
  import { githubMediaSources } from './lib/github-media.svelte'

  // GitHub media in a pull request body, drawn with the host's signed URL.
  // `withSource` gets null while the signature is on its way, then the URL to
  // load (the author's own when the host cannot sign it).
  let { serverId, source, withSource }: {
    serverId: string
    source: string
    withSource: Snippet<[string | null]>
  } = $props()

  // Asking writes the entry this reads; only a new source asks again.
  $effect(() => {
    const host = serverId
    const media = source
    untrack(() => githubMediaSources.request(host, media))
  })

  const src = $derived(githubMediaSources.sourceFor(serverId, source))
</script>

{@render withSource(src)}
