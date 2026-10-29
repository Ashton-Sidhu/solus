interface Env {
  ARTIFACTS: Artifacts
  PROOF_REPO: string
  PROOF_TOKEN?: string
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.PROOF_TOKEN || request.headers.get('authorization') !== `Bearer ${env.PROOF_TOKEN}`) return new Response('Unauthorized', { status: 401 })
    const url = new URL(request.url)
    if (url.pathname === '/ready') return new Response('ready')
    using repo = await env.ARTIFACTS.get(env.PROOF_REPO)
    if (url.pathname === '/history') return Response.json(await repo.log({ ref: 'main', limit: 100 }))
    if (url.pathname === '/file') {
      const file = await repo.readFile({ ref: url.searchParams.get('ref') ?? 'main', path: 'proof.txt' })
      return file ? new Response(file) : new Response('Missing', { status: 404 })
    }
    if (url.pathname === '/fork' && request.method === 'POST') {
      const fork = await repo.fork(`${env.PROOF_REPO}-fork`, { defaultBranchOnly: true })
      return Response.json({ name: fork.name })
    }
    if (url.pathname === '/delete-fork' && request.method === 'POST') return Response.json(await env.ARTIFACTS.delete(`${env.PROOF_REPO}-fork`))
    if (url.pathname === '/revocation' && request.method === 'POST') {
      const token = await repo.createToken('read', 900)
      const revoked = await repo.revokeToken(token.plaintext)
      // Only a synthetic repo-scoped token travels to the proof client, never to a report.
      return Response.json({ revoked, token: token.plaintext })
    }
    return new Response('Missing', { status: 404 })
  },
}
