# Host tunnels on their own site

Status: proposed (2026-10-31). Part of `docs/plans/fast-secure-startup.md` (decision 5,
step 8). No compatibility with today's tunnel addresses is kept.

## The problem

Every host is served under the account's own registrable domain:

- Linked hosts: `h-<hostId>.solus.sh` (`solus-cloud/src/lib/server/uplink/registration.ts`
  `hostnameFor`, `TUNNEL_DOMAIN=solus.sh` in `cloud-worker/wrangler.jsonc`).
- Managed hosts: `<name>-cf.solus.sh` (`host-worker/wrangler.production.jsonc`).
- The account: `app.solus.sh`.

A browser treats all of these as **one site** (`solus.sh`). A host is a machine its
owner controls, so its owner controls every page its tunnel serves. Such a page can:

- **Set cookies for the whole site.** `Set-Cookie: …; Domain=solus.sh` from
  `h-x.solus.sh` reaches `app.solus.sh`. With a longer `Path`, the attacker's cookie is
  sent before the real one ("cookie tossing"). The account can then read the attacker's
  session: a sign-in, an OAuth approval, or a device approval binds to the attacker's
  account (login CSRF), or a broken cookie signs the person out on every load.
- **Count as same-site.** `SameSite=Lax` and `Strict` do not stop a request from
  `h-x.solus.sh` to `app.solus.sh`: it is the same site. Writes are still protected
  today by exact `Origin` checks (`csrf.ts`, `v1.ts`, SvelteKit remote functions), but
  every new endpoint must remember to check.
- **Reach other hosts the same way.** `h-a.solus.sh` can set cookies that
  `h-b.solus.sh` receives.

## The fix

Put every host on a registrable domain of its own, and list that domain on the
**Public Suffix List** (PSL). This is how GitHub Pages (`github.io`), Vercel
(`vercel.app`), Netlify (`netlify.app`), and Cloudflare (`workers.dev`, `pages.dev`)
separate content their users control from their own sites.

1. **A new domain for hosts only**, for example `solushosts.net`. Nothing of the
   account, the site, or the API lives there.
2. **Hosts are one label under it:** `<hostId>.solushosts.net` for linked hosts,
   `<name>.solushosts.net` for managed hosts. The `h-` and `-cf` naming goes away;
   linked and managed hosts are told apart by the directory, not by their name.
3. **The domain is listed on the PSL** (private section, `solushosts.net`). Browsers then
   treat each `<x>.solushosts.net` as its own site: a host can set cookies only for
   itself, and requests between hosts are cross-site, so `SameSite` protects them.
4. **The account's cookies use the `__Host-` prefix** (Better Auth
   `advanced.cookiePrefix` / per-cookie names in `create-auth.ts`). A `__Host-` cookie
   must be `Secure`, host-only, and `Path=/`, so no other host, even on the same site,
   can set or shadow it. This also protects against any future subdomain of `solus.sh`.

Step 1 alone removes the attack on the account: `solushosts.net` is a different site
from `solus.sh`, whatever the PSL says. Step 3 adds isolation between hosts and takes
weeks to reach every browser (the PSL ships with browser releases). Step 4 is defence in
depth and has no cost.

## Changes

| Where | Change |
|---|---|
| Domain and DNS | Buy the domain. Add a Cloudflare zone, a proxied wildcard record, and Universal SSL (one level of wildcard is covered). |
| solus-cloud `registration.ts` | `hostnameFor` returns `<hostId>.<TUNNEL_DOMAIN>`; `TUNNEL_DOMAIN` becomes the new domain in `cloud-worker/wrangler.jsonc`. The tunnel route of every host is re-issued; hosts re-register (no compatibility). |
| solus-cloud `host-worker` | Managed hosts route on `*.<new domain>`; drop the `-cf` suffix and the `*-cf.solus.sh/*` route. |
| solus-cloud `create-auth.ts` | `__Host-` cookie names for the session and its cache. Existing sessions end once (no compatibility). |
| Solus clients | No change: they read routes from the directory. Remove any test or fixture that names `solus.sh` hosts. |
| Solus host server | No change to admission. The `Origin` the host sees from its own pages becomes `https://<id>.<new domain>`. |
| PSL | Open a pull request to `publicsuffix/list`, private section, with the `_psl` TXT record the maintainers ask for. |

## Checks

- A test in solus-cloud: a response from a tunnel hostname can never carry
  `Set-Cookie` for the account's domain, and the account's session cookie names start
  with `__Host-`.
- A test of `hostnameFor`: no host name is under `solus.sh`.
- After deploy: `app.solus.sh` and a host origin are cross-site in Chrome and Safari
  (`document.cookie` set with `Domain=` from the host page does not reach the account).

## Not covered here

Host pages can still run any script on their own origin; that is the owner's own
machine. The account never trusts a host origin: CORS and the `Origin` checks name only
`app.solus.sh`.
