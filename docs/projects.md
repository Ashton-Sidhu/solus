# Projects

A project is a folder on a host. Usually the folder is a Git repository.
Sessions, tasks and pull requests belong to a project.

## Start a project

There are three ways to start a project:

- **Start a new project…** An empty folder that has a Git repository. Use it when you
  start from nothing, for example "make me a website". You type the name. The
  host makes the folder name safe (`My Website` becomes `My-Website`) and runs
  `git init`. The new session opens in the folder. If a folder with that name
  already exists, the host refuses, and you choose another name.
- **Open an existing folder…** A folder that already exists on the host. The
  folder browser starts in the projects folder of that host, also for a remote
  host.
- **Get a project from GitHub…** or **Clone from a URL…** A copy of a
  repository. A pasted SSH URL (`git@…`) clones over SSH. Other repositories
  clone over HTTPS with the GitHub sign-in on the host. A line under the form
  says which one, and **Use SSH instead** or **Use HTTPS instead** changes it.

You can find these actions here:

| Entry point | New project | Open or clone |
|---|---|---|
| Open project dialog (`⌘⇧O`; `⌥⇧O` on the web) | first action | the other actions |
| Project chip above the composer | **New project…** | **Open project…** |
| Command palette | **New project…** | **Open project…** |
| Project switcher on a list page | — | **Open project…** |
| Mobile, a host's project list | **+** → **Start a new project** | **+** → the other actions |
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

**New project…** in the input header opens the main Open project screen,
as `⌘⇧O` does. Select **New project…** in that dialog to create a project. It uses the current project host and keeps the prompt
you have typed. Desktop and web use the same dialog. Mobile has its own
**Open project** screen with the same actions.

On the New project screen, type a name in **Project name**. The line below the
field tells you the folder that the host makes, the folder it goes in, and the
host, for example "Creates the folder My-Website in projects on Studio". The
full path shows as a tooltip. Select **Change** to choose another parent
folder (desktop and web only). Then select **Create project** to create the
folder and its Git repository.
A new project opens on the host the dialog is set to. Use the host chip in the
dialog header to change it.

## The folder browser

The folder browser opens a folder and saves a file. It has the same folder
operations for the two tasks:

| Operation | Button or menu | Key |
|---|---|---|
| New folder | **New folder** beside the filter, or the context menu | `⌥N` |
| Rename | Context menu on a folder | `F2` |
| Move to Trash | Context menu on a folder | `⌘⌫` on the highlighted folder |
| Copy path | Context menu | — |
| Open in Finder (Explorer, File Manager) | Context menu, only for your own machine | — |

To open the context menu, right-click, touch and hold on a phone, or push
`⇧F10` or the menu key. A right-click on empty space shows the operations for
the folder that is open.

**Move to Trash** asks you to confirm first. The folder goes to the Trash of the
host, so you can get it back. If the host has no Trash (for example, a Linux
server without `gio`), the browser tells you and asks again before it deletes
the folder permanently. The host does not remove the home folder or the
filesystem root.

## The projects folder

Each host has one projects folder. New projects are created there, and clones
go there. Settings → General → **Projects folder** shows the folder the host
uses:

1. The folder that the host owner set in Settings.
2. If none is set, `SOLUS_PROJECTS_ROOT`. A cloud host sets it to `/data/projects`.
3. If that is not set, `~/projects`.

On a cloud host, each member of the organization has their own folder,
`/data/projects/<user id>`. Settings shows that folder to the member.

## Cloud projects

A Solus Cloud project is a GitHub repository that the whole organization can
see. A new project on a cloud host is not a Solus Cloud project. It is in the
creator's own folder, and other members do not see it. To share it, use
**Publish to GitHub** in the project panel, then add the repository as a
project.

In cloud onboarding, **Start** on the repository step makes the repository a
project on the machine it will run on. If no online machine has a copy, that
machine clones it first. The chosen repository row shows the step:
**Starting** (a stopped cloud host), **Connecting to**, or **Cloning**. When
the project is ready, onboarding closes and a new session opens in it, ready
to send. If the clone fails, the row shows the reason and **Try again**. The
clone is a project on that machine, so the project chip lists it after that.

The project chip lists a project only when an online host has a copy of it.
A project whose copies are all on offline hosts, for example a laptop that is
asleep, is not in the list until that host is online again.

## Chats

A chat is a session with no project. Use a chat to ask a question or sketch an
approach when no repository is necessary. A chat is not a project: it does not
show in project lists, and it has no branch, worktree, Git panel, or pull
requests.

Each chat runs in a folder of its own, so the files of two chats never mix. The
folder is `.solus-chats/<session id>` in your projects folder on the host:

| Host | Chat folder |
|---|---|
| Your own machine, or a host you own | `<projects folder>/.solus-chats/<session id>`, for example `~/projects/.solus-chats/<session id>` |
| A shared or cloud host, as a member of the organization | `/data/projects/<your folder>/.solus-chats/<session id>` |

Solus does not show this folder. Every client knows a chat from the folder name
alone, so a chat reads **Chat** at once, before the host answers.

A new chat has no folder until you send its first prompt. Then the client names
the folder from the host's projects folder and the session id, and the host
makes it. If the client does not know the projects folder yet, it sends the
new-chat marker, and the host gives the chat the same folder. `~` is always the
home folder. It never means a chat.

When the projects folder of a host is inside a Git work tree, the host refuses
to start a chat and says why. An agent there would read and change that
repository. This can occur in development.

To start a chat:

- **Command palette or `⌘⌥N`.** **New chat** opens a new chat. It runs on the
  host of the conversation in front of you, else on the default machine.
- **Project chip.** When a draft has no project, the chip reads **Add project**.
  When a draft has a project, the last item of its menu is **Switch to chat**,
  which removes the project and keeps what you typed.
- **Onboarding.** **New chat** ends the flow in a new chat.
- **Mobile.** **Chats** on the host screen lists the chats of that host. **New
  chat** starts one.

A new session from a chat (⌘N) is a new chat, never the same chat folder. When
nothing names a project, a new session starts in the last project you used, or
in a new chat when there is none.

To add a project before the first prompt, select it in the project chip.

On a host that an organization uses (a managed host, or a personal host shared
with the organization), a chat starts **private**: only you see it until you
share it. A project session on that host starts shared with the organization.
Private means that Solus does not share the session with the organization. It
is not a security boundary: the members of the organization use one host, and
the host is a trusted team machine.

The agent knows that it is in a chat. It does not name the chat folder or run
Git there.

An automation with no project runs each time in a new chat of its own.

On a managed host, each turn runs on the seat of the member who sent it. If you
have no seat for the agent that you chose, the new session shows **Connect
Claude** or **Connect Codex** above the composer before you send.
