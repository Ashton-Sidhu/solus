<script lang="ts">
  import { untrack, type Snippet } from 'svelte'
  import { githubMediaSources } from './lib/github-media.svelte'

  // GitHub media in a pull request body, drawn with the host's signed URL.
  // `withSource` gets null while the signature is on its way, then the URL to
  // load (the author's own when the host cannot sign it).
  let { serverId, source, repository, withSource }: {
    serverId: string
    source: string
    repository: string | undefined
    withSource: Snippet<[string | null]>
  } = $props()

  // Asking writes the entry this reads; only a new source asks again.
  $effect(() => {
    const host = serverId
    const media = source
    const inRepository = repository
    untrack(() => githubMediaSources.request(host, media, inRepository))
  })

  const src = $derived(githubMediaSources.sourceFor(serverId, source, repository))
</script>

{@render withSource(src)}
