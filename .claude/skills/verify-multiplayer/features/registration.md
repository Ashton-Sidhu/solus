# Host registration

A host gets its identity at the Solus cloud when a signed-in owner client presents to it, with no link and no tunnel. Registration makes the host's record, its key (`private_key_jwt`), and its token audience. Removing the host ends its registration; registering again keeps the host id and makes a new key.

## Sub-features

- `register-no-link` registers a host with no tunnel; it is in the directory with no internet route.
- `register-owner` makes the signed-in person the host's owner.
- `register-remove` ends the registration ("Remove host"); after a restart the host reads as not registered and personal.
- `register-again` keeps the host id, advances the generation, and refuses the old key.

## How to get to it (user POV)

- Desktop: sign in; the desktop registers its own host by itself.
- Desktop, web, mobile: a host's Access screen shows "Registered to your account" (and a Register button when it is not).
- Website: Devices → Remove host.
- CLI: `solus connect` registers, then links.

## Driving it with the Lab

Preconditions:

- `DOCTOR OK`.

- **Register.** Run `bun lab run registration --cloud`. The host is listed in `/v1/hosts` with no route, and `uplinkStatus` says registered and not linked.
- **Owner.** The host's owner is alice.
- **Remove.** `DELETE /v1/hosts/:id` answers 204; the directory drops the host; its key gets no control token; after a restart the host logs `host_registration_refused` and reads as not registered.
- **Register again.** The host id stays; the generation advances; the token endpoint refuses the old key (401 `invalid_client`) and accepts the new one.
- **Proof.** `summary.json` lists `registration` with 0 failed checks.

## Gotchas

- A running host learns of its removal only when it next asks for its own token, or at boot; the scenario restarts it to reach that state.
- A host that holds no key registers with the next signed-in owner client; there is no separate re-registration rule (ADR §5, "A refused registration").
