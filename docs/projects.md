# Projects

A project is a folder on a host. Usually the folder is a Git repository.
Sessions, tasks and pull requests belong to a project.

## Start a project

There are three ways to start a project:

- **New project…** An empty folder that has a Git repository. Use it when you
  start from nothing, for example "make me a website". You type the name. The
  host makes the folder name safe (`My Website` becomes `My-Website`) and runs
  `git init`. The new session opens in the folder. If a folder with that name
  already exists, the host refuses, and you choose another name.
- **Open a folder…** A folder that already exists on the host.
- **Clone from GitHub…** or **Clone from a URL…** A copy of a repository.

You can find these actions here:

| Entry point | New project | Open or clone |
|---|---|---|
| Open project dialog (`⌘⇧O`; `⌥⇧O` on the web) | first action | the other actions |
| Project chip above the composer | **New project…** | **Open project…** |
| Command palette | **New project…** | **Open project…** |
| First-run onboarding | **Start something new** | **Open existing code** |
| Cloud onboarding, "Choose a project" | **Start a new project** | a repository in the list |

In onboarding, **Start something new** and **Start a new project** ask for the
name on their own screen. **Open existing code** also has its own screen. It
shows the recent projects on the host and **Choose a folder…**, which opens the
folder browser. Onboarding ends when the project exists, and a new session
opens in it. **Back** or Escape returns to the choices.

"How do you want to start?" is the last step of first-run onboarding. On
desktop, the optional **Connect to Solus Cloud** step comes immediately before
it.

**Change** on the New project screen creates the project in another folder.
A new project opens on the host the dialog is set to. Use the host chip in the
dialog header to change it.

## The projects folder

Each host has one projects folder. New projects are created there, and clones
go there. Settings → General → **Projects folder** shows the folder the host
uses:

1. The folder that the host owner set in Settings.
2. If none is set, `SOLUS_PROJECTS_ROOT`. A cloud host sets it to `/data/projects`.
3. If that is not set, `~/projects`.

On a cloud host, each member of the organization has their own folder,
`/data/projects/<user id>`. Settings shows that folder to the member.

## The chat folder

A session with no project runs in a chat folder (Scratchpad). A member of an
organization has their own chat folder, `.chat` in their member folder, for
example `/data/projects/<user id>/.chat`. The host owner, and every personal
host, use `my-workspace` in the Solus data folder (`~/.solus/my-workspace`).

- A chat on an organization space starts private. Only its owner sees it until
  they share it. A project session starts shared with the organization.
- When the client does not know the folder yet, it sends `~`. The host reads a
  bare `~` as the caller's chat folder, not the home folder. `~/x` is still a
  path in the home folder.
- If the chat folder is inside a Git work tree, the host does not report it, and
  the client does not show Scratchpad. This can occur in development, when the
  Solus data folder is inside a checkout.

## Cloud projects

A Solus Cloud project is a GitHub repository that the whole organization can
see. A new project on a cloud host is not a Solus Cloud project. It is in the
creator's own folder, and other members do not see it. To share it, use
**Publish to GitHub** in the project panel, then add the repository as a
project.

## Scratchpad

Scratchpad is the place where a session with no project runs. Use it to ask a
question or sketch an approach when no repository is necessary. Scratchpad is
not a project: it does not show in project lists, it has no branch or
worktree, and it is on every host.

Each host keeps Scratchpad in a folder that the host names. The client does
not build the path:

| Host | Folder |
|---|---|
| Your own machine, or a host you own | `~/.solus/my-workspace` (in the data folder of the host) |
| A shared or cloud host, as a member of the organization | `/data/projects/<user id>/.chat`, in your own member folder |

Each member has one Scratchpad on each host. All your chats on that host use
the same folder. When the Scratchpad folder of a host is inside a Git work
tree, the host does not offer Scratchpad, and Solus does not show it for that
host.

To start a chat in Scratchpad:

- **Project chip.** The **Scratchpad** row is at the top of the list. It opens
  Scratchpad on the host the session will run on (the Run on host).
- **Command palette.** **Just chat** opens a new session in Scratchpad. At a
  Solus Cloud origin it uses the managed host of your organization. On desktop
  it uses this computer. In all cases, it uses the host of your last
  Scratchpad chat first, if that host is up.
- **New session headline.** When a new session is in a project, **or just chat**
  below the headline moves it to Scratchpad on the same host.
- **Onboarding.** **Just chat** and **Start without a project** end in
  Scratchpad.

To go back to a project before the first prompt, select the project in the
project chip.

On a managed host, a chat in Scratchpad starts **private**. Private means that
Solus does not share the session with the organization. It is not a security
boundary: the members of the organization use one host, and the host is a
trusted team machine.

On a managed host, each turn runs on the seat of the member who sent it. If you
have no seat for the agent that you chose, the new session shows **Connect
Claude** or **Connect Codex** above the composer before you send.
