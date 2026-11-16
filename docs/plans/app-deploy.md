# App deploy: develop in Solus, publish a container

Status: the publish model, decided 2026-11-15. The server part and the
Deployment section of each client are built; §10 says what is there and §11
what is not. §12 says which earlier model this
one replaced, and why.

Picture: the Solus work "App deploy model"
(`ff9306a0-9050-49fa-bc4f-627342913f42`). Where this text and the picture
differ, this text wins.

This plan adds to `docs/plans/apps.md`. It changes decision 12 there ("Only
the host's owner uses an app") for a published copy, and it builds three
items of its §12: "A URL for an app", "The cloud copy", and Executor's two
scopes for credentials.

## 1. Problem

An app runs in one place: a child process on the host that has its record.
Each caller is the owner, and each caller comes in through Solus. A person
cannot keep an app on while their machine is off, and cannot give it to
people who do not have Solus.

## 2. The idea

An app stays in Solus, where its owner and their agents work on it. A
**publish** runs a copy of its active version in a container of its own, as a
deploy runs a site on Vercel or Fly. The copy has its own data and an address
that a browser opens. Solus does not manage the copy as if it were local: it
sends a version, reads a status, and reads a log.

The copy is a normal web program. It calls Solus, as a service, only for what
Solus owns. When Solus is off, the copy still serves its page and its data.

## 3. Vocabulary

- **publish** — to send the active version of an app to its deployment, and
  to make the deployment first when the app has none. A deploy in Solus is
  not a publish.
- **deployment** — the published copy of an app: one container with the
  runtime, the versions it received, its own data, and its env vars. An app
  has one deployment or none.
- **unpublish** — to remove the deployment with the data it holds.
- **runtime** — the program in a deployment. It serves the app's page and its
  calls over HTTP, runs the schedules and the workflows, and keeps the call
  log.
- **runtime image** — `solus-apps-runtime`: the one image of the runtime, the
  same for each app. It holds no app.
- **management API** — what Solus asks of a deployment: take a version, and
  say how it is. Each request is signed with the app key.
- **service API** — what a deployment asks of Solus: a tool of an app
  connection, and the delivery of its signals.
- **app key** — the secret that names one deployment to Solus. It grants
  nothing by itself.
- **address** — the URL where a browser opens the deployment.
- **link** — the address with a secret in its fragment. It opens a private
  deployment.
- **visitor** — a person at the address. A visitor is no person of Solus.
- **app connection** — an integration that the owner links to the app for
  everyone. Each caller and the background work use it through the app.
- **user connection** — a caller's own connection. The rule of today.
- **platform** — the kind of place that runs a container: `docker` or
  `solus-cloud`. Tailscale is not a platform: it is a switch of a deployment.
- **platform adapter** — the code that runs a container on one platform.

Do not say "move" or "install" for a publish: the app does not leave Solus.
Do not say "environment" or "instance" for a deployment. Do not say "account"
for a connection.

## 4. Decisions

Decided 2026-11-14 and 2026-11-15 by the maintainers:

1. **Solus is a service.** A published app is not a part of Solus. It gets an
   app key and calls Solus for what Solus owns.
2. **The app stays in Solus, and a publish runs a copy** (the publish model).
   The copy has its own data. Nothing moves.
3. **The source and the build stay in Solus.** A deployment holds built
   versions: no source, no npm, and no compiler.
4. **A deployment is Docker,** one container for each app. An app in Solus
   stays a process.
5. **App data is always beside the container.**
6. **Tailscale is an address.** It is a switch of a deployment, not a
   platform. A sidecar makes the app one node on the tailnet. `tailscale
   serve` on the host's own node was refused: it changes Tailscale state that
   Solus does not own.
7. **Solus Cloud is for a person who is signed in,** and it runs each app in
   a container on Cloudflare.
8. **A deployment is private by default.** Its link opens it. The owner can
   make it public.
9. **In a deployment, a connection acts as the owner,** and only when the app
   names it as an app connection.
10. **Solus gives a public app no user accounts, no durable database, and no
    abuse control.** The author builds these into the app.
11. **The Solus server as a Docker image is not a part of this plan.**

Decided in the code, for a maintainer to confirm:

12. **A publish is its own act.** A deploy in Solus does not publish. So the
    owner tries a version in Solus before other people get it.
13. **The app's own secrets are env vars of the container.** A publish with
    other secrets starts the container again on the same data.
14. **The config goes with each publish.** The deployment runs with the
    config the app has in Solus at that time.
15. **No token of a connection is in a deployment.** Solus runs the tool and
    answers the result.
16. **A visitor has a role and no identity.** A viewer runs what reads. An
    editor runs queries and mutations. `ctx.caller` has the role and no
    user.

Decided 2026-11-16 by the maintainers:

17. **People, teams, and organizations sign in at the address** (§7.3). The
    list is the owner's, with the subjects that Solus sharing has.
18. **Each caller of a copy can start a model call.** It runs with the
    owner's model account. The owner guards it in the app's own code.

Decided in the code on 2026-11-16, for a maintainer to confirm:

19. **The sign-in of a copy is not an OAuth client.** Solus Cloud signs the
    visitor in on its own page, decides the role from the owner's list, and
    sends a one-use code back to the address that the owner's host gave. The
    OAuth server of Solus Cloud does not change (§7.3).
20. **A person the owner did not name is not told to the copy.** Solus Cloud
    stops them on its own page.
21. **The owner names only what is theirs:** a team or an organization they
    are in, and a person of one of their organizations.
22. **A webhook of a copy has the signing secret that it has in Solus.**
23. **A person has at most ten copies on Solus Cloud.**

## 5. The parts

```text
Solus                                     deployment (one container)
  the app: source, builds, versions  ──▶    built versions
  its Manage page, its agents               its own data, its call log
  publish, status, log               ──▶    management API   (signed)
  service API                        ◀──    SOLUS_URL, SOLUS_APP_KEY
                                            the app's secrets as env vars
                                     visitors ──▶ address
```

### 5.1 The runtime

`packages/server/src/apps/runtime/`. It is the Apps service of a host with one
app in it, over its own data folder (`SOLUS_DATA_DIR`, `/data` in the image).
It composes the parts that `boot-server.ts` wires, so no code is copied.

- A build it received is a folder of the version's files. A deployment has no
  git.
- It reads the app's own secrets from `SOLUS_APP_SECRET_<NAME>`.
- It keeps each version it received, so an earlier one can run again.
- With no `SOLUS_URL` it runs with no Solus: each service call fails with a
  clear message.

### 5.2 The service API

What a deployment asks of Solus, with `Authorization: Bearer <app key>`, at
`/apps/service/v1/`:

| Call | Solus does |
|---|---|
| `tool` | Runs a tool of an app connection with the owner's connection, and answers the result. A user connection is refused: a visitor is no person of Solus. |
| `signals` | Keeps each occurrence and runs the owner's signal actions. |
| `models` | Starts, reads, lists, or cancels a model call (`docs/plans/app-models.md`). Solus runs the call with the owner's model account. Each operation that the call uses as a tool runs in the deployment, through the management path `operations`. The record of the call is beside the records of the app in Solus, so the owner reads it in Activity. |

A deployment that waits for a model call reads it each second and a half. No
request stays open for the whole call: a tunnel ends a long request.

The app key names the app and the version that is published. A key of a
deployment that is gone gets a 401.

### 5.3 The management API

What Solus asks of a deployment, at `/_solus/v1/`. Each request has a
signature made with the app key, so the key does not cross in this direction,
and a recorded request stops working after five minutes.

| Path | Is |
|---|---|
| `GET health` | Not signed. A platform asks only whether the process answers. |
| `GET status` | The runtime's release, the active version, the calls of 24 hours, and the access. |
| `POST versions` | One built version, the config, and the access. The deployment makes it active. A version that does not start leaves the one before it running. |

### 5.4 The platform adapter

```ts
interface AppPlatform {
  kind: 'docker' | 'solus-cloud'
  /** Ready, or what is missing: Docker is not running, the image is not there. */
  readiness(spec: AppDeploymentSpec): Promise<AppPlatformReadiness>
  /** Runs the runtime image with its env vars, its volume, and its port. */
  run(spec: AppDeploymentSpec): Promise<AppDeploymentEndpoint>
  stop(appId: string): Promise<void>
  status(appId: string): Promise<AppContainerStatus>
  logs(appId: string, lines: number): Promise<string>
  /** Removes the container, the sidecar, the address, and the data. */
  remove(appId: string): Promise<void>
}
```

A new platform is one more of these. The `docker` platform publishes the
management port on the loopback interface of the host, keeps the data in a
named volume, and names each env var with no value in the argument list, so no
secret is in the process list.

## 6. Connections in two scopes

Executor has this model, with "account" for our "connection".

| | App connection | User connection |
|---|---|---|
| In `app.ts` | `appIntegrations` | `integrations` |
| Who links it | The owner, with a connection of their own, for everyone. | Each caller, their own. The rule of today. |
| Who acts with it | Each caller, each schedule, each webhook, and each workflow, through the app's code. | Only that caller. |
| A call with no person | Uses it. | Is refused, with a message that names `appIntegrations`. |
| A visitor of a deployment | Acts with it and does not see it. | Has none. |

This is protocol 4 (apps.md §6.3). A name is in one scope only. A build of
protocol 3 has user connections only, and there a call with no person still
uses the owner's connection, as before. A deployment gives a protocol 3 build
no connection: it must name its app connections first.

`ctx.caller` of a call from the UI has `role` (`owner`, `editor`, or
`viewer`) and, for a person of Solus, `user`.

## 7. The address and its access

- **A deployment is private.** Its page and its calls answer a browser that
  came in with the link. The link is the address with a secret in its
  fragment, `https://<address>/#<secret>`, so a proxy does not see it. The
  page changes the secret for a cookie, and the secret leaves the address
  bar.
- **A new link** puts each earlier visitor out, because a session holds only
  while the link that made it does.
- **Public** answers each browser, with no link.
- **The role** of the link, or of public, says what a visitor may do (decision
  16).
- **The page** is the app's built UI with `window.solusApp` in it, as Solus
  puts it in the app frame. Its calls go to the deployment over HTTP, and the
  news of changed data comes as server-sent events.
- **A call needs a header** that a page of another site cannot send, so
  another site cannot make a visitor's browser call the app.
- **The page reaches** the deployment and the network hosts that the app
  names, and no other host.

### 7.3 Named people

The third access is `people`: only the owner and the people, teams, and
organizations that the owner names open the app, and each one signs in to
Solus. It needs the owner signed in to Solus on the host of the app.

```text
browser                     the copy                         Solus Cloud
  │  GET /                    │                                  │
  │ ◀── "Sign in with Solus" ─┤                                  │
  │  GET /_solus/app/sign-in  │                                  │
  │ ◀── 302, and a cookie with a verifier                        │
  │  GET /apps/enter?app&state&challenge ───────────────────────▶│ signs in, reads the owner's list
  │ ◀── 302 to <address>/_solus/app/callback?code&state ─────────┤ (or stays: "not shared with you")
  │  GET /_solus/app/callback │                                  │
  │                           │  POST /v1/apps/entry {app, code, verifier} ─▶│
  │                           │ ◀── { user: { id, name }, role } ────────────┤
  │ ◀── 302 to /, and a session cookie                           │
```

- **Solus Cloud keeps the list and decides the role.** At each publish with
  this access, the Solus of the app sends the address and the list
  (`PUT /v1/apps/<app id>/access`). The copy holds only where to send a
  visitor. The Solus of the app keeps the list too, so a change of the access
  to a link and back has it.
- **The role** is `owner` for the owner, else the highest of `editor` and
  `viewer` that the list gives the person. `ctx.caller` has the role and the
  person: `{ kind: 'ui', role, user: { id, name } }`.
- **The code goes only to the copy.** The redirect is to the address that the
  owner's host gave, never to a part of the visitor's request. The copy
  proves that it started the sign-in with the verifier of the challenge, and
  a code works once and for one minute.
- **A session holds twelve hours.** A change of the list holds for a person
  at their next sign-in. A new link, which makes a new secret, ends each
  session at once.
- **This is not an OAuth client** (decision 19). The copy is at another
  origin and is the owner's own program; a client for each copy in the OAuth
  server of Solus Cloud would put a program of each person among the Solus
  clients. The flow is the authorization code flow with PKCE, with Solus
  Cloud as the one that decides.

### 7.4 Webhooks

Another service sends a webhook that the app declares to
`<address>/_solus/hooks/<name>`. The runtime checks the request as the
webhook owner of a host does, with the scheme the app declares and the
signing secret that the webhook has in Solus, which is an env var of the
container (`SOLUS_APP_WEBHOOK_SECRET_<NAME>`). A request that passes runs the
mutation with `{ headers, query, body }`. A copy keeps no delivery log, does
not replay, and does not drop a repeated delivery (`replayKey`).

## 8. The places

### 8.1 Docker on a host

One container for each app, `solus-app-<app id>`, from the runtime image
`ghcr.io/ashton-sidhu/solus-apps-runtime:<release>`
(`SOLUS_APPS_RUNTIME_IMAGE` names another). The release of the server builds
the image for amd64 and arm64 and pushes it
(`.github/workflows/release-server.yml`), and a host pulls it at its first
publish. A pull that fails leaves the container that runs. The address is a
loopback port of the host, so a browser on that host opens it. The container
reaches the service API at `host.docker.internal`.

### 8.2 Tailscale

Built in the `docker` platform, and not run against a real tailnet. With the
Tailscale switch, a sidecar container (`tailscale/tailscale`) holds the
network, and the runtime's container joins it. The sidecar's host name is the
app's slug, and its `tailscale serve` sends HTTPS on to the runtime. The
address is the name that the tailnet gave the node,
`https://<slug>.<tailnet>.ts.net`. The host's auth key is set in Settings, on
the host's page, and is kept in the secret store of the host; a client never
reads it back. The env var `SOLUS_TAILSCALE_AUTHKEY` of the Solus server is
used when the store has none. The key goes to the sidecar by name and never
to the app's container.

### 8.3 Solus Cloud on Cloudflare

Built, and run on Cloudflare as a trial. Three parts, in `solus-cloud`:

| Part | Does |
|---|---|
| The cloud application (`src/lib/server/published-apps/`, `docs/uplink.md`) | `/v1/apps/<app id>/machine`: for the signed-in owner, it names a machine, asks the app Worker to run it, and keeps one row for the copy. The env vars pass through and are not stored. A person has at most ten machines. |
| The app Worker (`app-worker/`) | Sends each request to the Durable Object of the app. Its management endpoint, `/_cloud/v1/apps/<name>`, takes a token that only the cloud application has. |
| Durable Object, one for each app | Starts the container for a request. After ten idle minutes it stops the runtime, saves `/data` to R2, and ends the container. The next request starts a new container and restores `/data` before the runtime opens it. |

- **The Worker knows nothing of the app.** Who may open the app, and what
  Solus may ask of it, are the runtime's own checks: the link or the sign-in,
  and the signature of the app key. Solus sends a version through the app's
  own address.
- **An app that sleeps starts by itself.** Before each sleep, the Durable
  Object reads the runtime's health path, which says when the app must run
  next: its next schedule, or a sleeping run. It sets an alarm for thirty
  seconds before that. A run in progress, or work that is due in two minutes,
  keeps an idle container.
- **A machine's name** is the app's slug and six random bytes, and it is the
  first label of the app's host name: `<slug>-<random>.<apps domain>`.
- **The domain for apps is not `solus.sh`.** The page of an app is code that
  an agent wrote, and a page on a host name under `solus.sh` can set cookies
  for `app.solus.sh`. The production Worker (`wrangler.production.jsonc`) is
  not deployed: the account has no such domain yet. The trial Worker serves
  on workers.dev, which has one host name, so it holds one app.
- **The `solus-cloud` platform** of a Solus is `SolusCloudPlatform`. It asks
  the cloud application with the token the host holds for its owner. A host
  whose env names an app Worker (`SOLUS_CLOUD_APPS_URL`,
  `SOLUS_CLOUD_APPS_TOKEN`, `SOLUS_CLOUD_APPS_NAME`) asks that Worker itself,
  with no account.
- **A cloud copy reaches its Solus through the tunnel.** `SOLUS_URL` is the
  address that Solus Cloud gives the host of the app, while that host is
  online. When the host is off, the copy still serves its page and its data,
  and a tool of an app connection, a signal, and a model call fail.

### 8.4 An exported image

`export_app` writes the build context of a self-contained image of the active
version: a Dockerfile from the runtime image, the version as one file, and a
README with the commands. The image runs with no Solus and no adapter. Its
access is in its env vars: `SOLUS_APP_ACCESS`, `SOLUS_APP_ROLE`, and
`SOLUS_APP_LINK_SECRET`.

### 8.5 Docker on a connected host

The owner works on an app on one host and has another host that is always
on. A publish can run the container on that other host. The app, its record,
its key, and the owner's connections stay in the Solus of the app.

```text
host A (the Solus of the app)                 host B (a connected host)
  AppDeployments                                HostedAppContainers
    ConnectedHostPlatform  ── appContainer* ──▶   DockerPlatform
    DeploymentClient       ── appContainerManage ▶ the runtime, on a loopback port of B
  the service API  ◀── SOLUS_URL ─────────────── the container
```

- **Host A reaches host B as a client does,** with the connection that a
  session on another host uses (`RemoteHosts`): the hosts of the owner's
  account, and the hosts that one of their devices introduced.
  `appPublishHosts` lists them.
- **Host B runs the container and knows nothing of the app.** It holds no
  record, no key, and no version. Its containers are
  `solus-hosted-app-<app id>`, so they never have the name of a deployment of
  host B's own app. Only the owner of host B asks: a container is code that
  runs there.
- **Each request of the management API goes through host B**
  (`appContainerManage`), because host A does not reach a loopback port of
  host B. Host B is a pipe: the runtime checks the signature, which only host
  A can make. Host B carries the three management paths and no other.
- **The container reaches host A** at the route of host A with the widest
  reach (`SOLUS_URL`). A host A that listens on loopback only has no such
  route, and then a tool of an app connection and a signal do not work.
- **The address** is a loopback port of host B, or the name on the tailnet
  when the Tailscale switch is on. The auth key is host B's.
- **A deployment stays in its place.** A publish to another host or another
  platform is refused: unpublish first, because the data is in the place.
- **When host A does not reach host B,** the section says so, and Unpublish
  is refused and keeps the record: the container can still run there.

## 9. What each surface gets

- **Agent tools:** `publish_app` (with `platform` and `host` for a first
  publish) and `unpublish_app`, each with approval, and `export_app`.
- **RPC, answered by the Solus of the app:** `appPublish`, `appUnpublish`,
  `appDeployment`, `appDeploymentLogs`, `appPublishPlaces`, and
  `appTailscaleKeySet`.
- **RPC, answered by a connected host:** `appContainerRun`,
  `appContainerStatus`, `appContainerLogs`, `appContainerRemove`, and
  `appContainerManage`.
- **Manage page** (desktop, web, mobile): the Deployment section. An app that
  is not published shows the choices of a first publish: where it runs, the
  Tailscale switch, who opens it, and what a visitor does. A published one
  shows how the copy is, the version that a publish sends when the copy is
  behind, the address with a copy control for the link, who opens it, the
  role or the list of people, a new link, the address of each webhook, the
  Tailscale switch, the log, and Unpublish. The rules and the words are in
  `client-core/src/app-deployment.ts`, so the three clients say the same.
- **The host says what it has** (`appPublishPlaces`): each place with what it
  lacks now, whether the host has a Tailscale key, and whether its owner is
  signed in to Solus. The section says what is missing before a publish.
- **Settings, the host's page** (desktop, web, mobile): the Tailscale auth
  key. It is set, replaced, or removed, and never shown.
- **The list of people on mobile:** the phone shows how many the list names
  and changes the access, and it does not change the list. It has no picker
  for the people and teams of an organization, as for the session of a signal
  action (`apps.md` §9). A maintainer must confirm this exception.
- **A publish keeps what the deployment has.** A thing that a request does
  not name stays: a publish of a new version does not make a public app
  private. Each change of a deployment is a publish, and a publish sends the
  active version, so a change of a copy that is behind asks first and says
  that it also publishes that version.
- **Events:** `apps.activity` with the kind `deployment` after a publish or an
  unpublish, so each client that shows the section reads it again.
- **Reverse states:** unpublish, public or people back to a link, a person
  off the list, a new link, the Tailscale switch off, and the Tailscale key
  removed.
- **Providers:** no difference between Claude and Codex.

## 10. What is built

Built 2026-11-15 and 2026-11-16, on the server and on each client. The two
sides are tested as two processes over real HTTP, in a real container of the
image on Docker (`app-docker-publish.test.ts`, with a container on a
connected host), and on Cloudflare (`app-cloud-publish.test.ts`, which runs
only when the env names a Worker). The Deployment section was not opened in a
running client.

| File | Owns |
|---|---|
| `contracts/src/app-deployments.ts` | The management API, the service API, what a visitor's browser asks, the env vars, and a deployment as a client reads it. |
| `server/src/apps/runtime/app-runtime.ts` | `AppRuntime`: takes built versions, answers a visitor, and keeps the access. |
| `server/src/apps/runtime/runtime-http.ts` | The listener: the management API, and the address. |
| `server/src/apps/runtime/deployment-builds.ts` | The builds a deployment received, as folders. |
| `server/src/apps/runtime/management-signature.ts` | The app key and the signature of a management request. |
| `server/src/apps/runtime/solus-service-client.ts` | The service API as a deployment calls it. |
| `apps/apps-runtime/src/index.ts` | The process of the container. |
| `scripts/build-apps-runtime.ts`, `packaging/apps-runtime/Dockerfile` | The image: `bun run build:apps-runtime`, then `docker build -t solus-apps-runtime:<release> dist/apps-runtime`. |
| `server/src/apps/deployments/app-platform.ts`, `docker-platform.ts`, `solus-cloud-platform.ts` | The adapter interface, the `docker` platform, and the `solus-cloud` platform. |
| `server/src/apps/deployments/cloud-machines.ts` | Solus Cloud as the Solus of an app asks it: the machines, and the access of a copy with named people. |
| `server/src/apps/deployments/tailscale-key.ts` | The Tailscale auth key of the host, in its secret store. |
| `solus-cloud/src/lib/server/published-apps/`, `src/routes/v1/apps/`, `src/routes/apps/enter/` | The cloud API for the machines and the access, and the sign-in page (§7.3, §8.3). |
| `solus-cloud/app-worker/` | The app Worker, its Durable Object, and the Cloudflare image (§8.3). |
| `server/src/apps/deployments/app-deployments.ts` | `AppDeployments`: publish, unpublish, the view, and the log. The record of a deployment is a file beside the app data; its app key and the secret of its link are in the secret store. |
| `server/src/apps/deployments/deployment-client.ts` | The management API as Solus calls it. |
| `server/src/apps/deployments/connected-host-platform.ts`, `hosted-app-containers.ts` | A container on a connected host (§8.5): the adapter in the Solus of the app, and the service of the host that runs the container. |
| `client-core/src/app-deployment.ts` | The rules and the words of the Deployment section, for each client. |
| `workspace-ui/src/components/app/manage/DeploymentSection.svelte`, `mobile/src/features/apps/sections/DeploymentSection.tsx` | The Deployment section on desktop and web, and on mobile. |
| `server/src/apps/deployments/app-service-api.ts` | The service API. |
| `server/src/apps/apps.ts` | `published()`: what a deployment gets of the app. The scopes of a connection. The role of a UI caller. |
| `server/src/transport/http.ts` | `POST /apps/service/v1/*`, open on the tunnel too. |

Tests: `app-deployment-runtime.test.ts`, `app-deployments.test.ts`,
`app-docker-platform.test.ts`, `app-connection-scopes.test.ts`, and
`app-deployment-view.test.ts`. In `solus-cloud`:
`src/lib/server/published-apps/published-apps.test.ts`.

Notes on what is there:

- **The runtime is not a package of its own.** It is in the apps domain of the
  server. The bundle is one file of 3.5 MB and carries server modules that
  the runtime does not use.
- **The image build defines the OAuth client values of the server as empty.**
  The server bundle takes them from the build machine, and this image is
  public.
- **The app in Solus and its deployment each run the app's schedules.** An
  owner who wants one of them to run stops the app in Solus.

## 11. Not built

Not exercised:

- **A release of the image.** The job in the release workflow did not run.
  The package on the registry is private at its first push: a maintainer
  makes it public once.
- **The cloud application on Solus Cloud.** The API and the sign-in page are
  tested against the real migration in PGlite. They are not deployed, and no
  real host called them.
- **The Deployment section in a running client.**
- **A run of the two real hosts.** A publish to a connected host is tested
  with the two services in one process and a real container. The connection
  between two real Solus servers, and the route that the container reaches
  host A at, were not exercised.
- **A run of the Tailscale sidecar on a real tailnet.** How the sidecar
  starts (`/usr/local/bin/containerboot`) and what headers its proxy sends
  are from the Tailscale documents, not from a run.

Not built:

- **A domain for the cloud apps,** and with it the production app Worker
  (§8.3).
- **The list of people on mobile** (§9).
- **A link and named people at one time.** The access is one of three.
- **A consent of the visitor** before the copy learns their name. The owner
  named them, so the owner knows them already.
- **The log of a cloud copy** in the Deployment section.
- **A status read that lets a cloud app sleep.** The Deployment section asks
  the runtime how it is, and that request starts a sleeping app.
- **A delivery log, a replay, and a check for a repeated delivery** of a
  webhook in a copy (§7.4).
- **Telemetry** from a deployment to Solus. The owner reads the container's
  log.
- **A Docker container that stops when idle.** Nothing is before the
  container to start it again for a request, and the address must stay the
  copy's own. The runner process in the container stops after five idle
  minutes, as in Solus; the runtime stays.
- **Public for a work.**
- **Docker on Linux** reaches the service API at `host.docker.internal` only
  when the Solus server listens on an interface that the container reaches.

## 12. The model before this one

Until 2026-11-15 the plan was the management model: an app moved into its
deployment with its data, and Solus still showed and ran it as if it were
local. Steps 1 and 2 of that model were built. It was replaced because one
rule made most of its code: a deployed app had to look and act like a local
app inside Solus.

- Each app RPC needed a choice: answer here, or send it to the deployment.
- The versions, the config, the secrets, and the schedules were on two sides
  and had to stay in step.
- A move copied the data in two directions, and a test caught schedules that
  would fire two times.
- The identity of a caller had to travel to the deployment and back.

The runtime, the image, the push of a version, the `docker` platform, and the
service API stayed. The router, the move, and the identity path went.

## 13. What Executor does

Read at `f92acac` on 2026-11-15. Executor does not deploy an app by itself.
An app runs inside the Executor server, in an isolate. What deploys is the
server.

| Executor | This plan |
|---|---|
| An app stores no credential. The server gives the app's code the accounts of each call. | A deployment stores none either. It asks with its app key, and Solus runs the tool. |
| Two scopes: an app account, linked by an editor for everyone, and a user account, each caller's own. | Taken (§6). |
| An API key is a personal token with no permissions of its own. | The app key grants nothing by itself. |
| Each app page has its own origin. | Each cloud app has its own host name (§8.3). |
| An app is used by its creator only, by groups, or by the organization. No app is public. | Private by default, with a link, and public (§7). |
