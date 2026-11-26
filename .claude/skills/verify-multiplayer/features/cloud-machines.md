# Cloud machines

A member of an organization creates a managed host (a cloud machine). The machine gets a link code in its environment (`SOLUS_LINK_CODE`), enrolls with it and its own key at boot, and links itself. Members reach it with their own sign-ins and a host token that lists the organization; people outside the organization get no token.

## Sub-features

- `machine-create` creates a managed host as a member.
- `machine-register` makes the machine enroll at boot with the link code in its environment and its own key, and then link itself at the address the cloud has.
- `machine-reach` gives members a 300 s host token with the organization, and admits them as `org-member`.
- `machine-refuse` refuses a person of another organization at the cloud.
- `machine-bootstrap` enrolls the machine at boot with the link code from its environment, keeps its link system-owned, and trusts nobody by network position (`managed-bootstrap`, Lab issuer).

## How to get to it (user POV)

- Desktop, web, mobile: Hosts → new cloud machine; the Run on picker starts and opens it.
- Website: the organization's hosts.

## Driving it with the Lab

Preconditions:

- `DOCTOR OK`.

- **Create.** Run `bun lab run cloud-machine --cloud`. bob creates the machine with `POST /v1/hosts` in a new organization.
- **Register.** The Lab boots the machine with the `SOLUS_LINK_CODE` the dev provider prints (`[memory hosts] service solus booted on machine <name>`, then `{ SOLUS_LINK_CODE: '<code>' }`); the machine enrolls with the code and its key before it listens (`host_enrolled_at_boot` in its log), links itself with no tunnel, and is listed with a route.
- **Reach.** alice and bob each get a 300 s host token whose `organizations` claim lists the organization, and pass its ticket door as `org-member`.
- **Refuse.** carol gets 400 `invalid_target` (`host_not_found`), and her sign-in still works.
- **Proof.** `summary.json` lists `cloud-machine` with 0 failed checks.

## Gotchas

- `managed-bootstrap` (Lab issuer) PASS (2026-10-13): it reads the registration apart from the link, and a member's projects folder is their member folder, `<name>-<id slug>` (commit 010992d89). `cloud-machine` (cloud) passes.
- Both scenarios changed with the one join path (2026-11-25: `SOLUS_LINK_CODE`, enrollment at boot, the machine links itself). They were not run again after that change.

- The managed-host provider is the dev in-memory one; a real Cloudflare container is proved only on a deploy.
- The machine stays in its organization after the run (only the owner deletes it, on the website); each run makes a new organization.
- There is no Solus API in cloud mode yet: organization work on a host is refused.
