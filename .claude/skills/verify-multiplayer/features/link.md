# Link and unlink

Link exposes a registered host to the internet through a cloudflared tunnel, and does nothing else. Unlink removes only the tunnel. The host's identity, key, delegations, and account reads do not change either way.

## Sub-features

- `link-on` adds the tunnel and its route in the directory; the host answers through it.
- `link-off` removes the tunnel and the route.
- `link-nothing-else` keeps the host id, the generation, the delegations, and account reads the same before, while, and after.

## How to get to it (user POV)

- A host's Access screen: the "Reachable from the internet" switch (desktop, web, mobile).
- CLI: `solus connect` (links after it registers).

## Driving it with the Lab

Preconditions:

- `DOCTOR OK`.

- **Link.** Run `bun lab run link --cloud`. The directory route appears; `GET <route>/health` answers 200; alice dials the host at that route with her host token.
- **Nothing else changes.** The host id, generation, delegation log entries, and an account read are the same before, while linked, and after unlink.
- **Unlink.** The route is gone from the directory.
- **Proof.** `summary.json` lists `link` with 0 failed checks.

## Gotchas

- In development the tunnel is a stub: its route is the host's own listener on loopback (`stubTunnelRoute` in solus-cloud). A real Cloudflare tunnel is proved only on a deploy.
- A host must be registered before it can link.
