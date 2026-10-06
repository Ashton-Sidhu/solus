# Projectless chat

Status: done. This replaces Scratchpad. User-visible behavior is in
[Projects → Chats](../projects.md#chats).

## Problem

A non-technical user found Scratchpad confusing. Scratchpad was a fake project
for a session with no project. It had these problems:

- The word "Scratchpad" showed on the draft headline ("What should we build in
  Scratchpad?"), the project chip, the sidebar, the status bar, the folder
  picker, automations, and toasts.
- A chat looked like a project. It had a project icon and a row in the project
  list.
- The client found a chat by an exact match of its path against the chat folder
  of its host. The client fetched that folder for each host. Until the answer
  came, a row showed the folder name (`.chat` or `my-workspace`), and then it
  changed to "Scratchpad".
- Two responses reported the chat folder (`start` and capabilities), and they
  did not always agree.
- A bare `~` meant "the chat folder" on the server. `~` is a valid directory
  (the home folder), so this was wrong.
- All chats on a host shared one folder, so their files mixed.
- Mobile could not start a chat, and it did not show chats that other clients
  started.

## Decision

A chat is a kind of session, not a place.

- A session has an optional project. A session with no project is a **chat**.
- Each chat runs in its own folder: `<projects root>/.solus-chats/<session id>`.
  The owner and the members of an organization use the same rule. A member's
  projects root is their member folder, so every chat is outside the host's
  data folder.
- The folder's name marks a chat. `isChat` in `@solus/contracts/chat` answers
  from the path alone, on the server and on every client. No client fetches a
  chat folder, and no session record needs a new field.
- `~` is the home folder. It never means a chat.

We had no users, so this change made clean cuts. It keeps no old folder names
and no old data. Sessions in the old `my-workspace` and `.chat` folders are no
longer chats.

## Vocabulary

| Term | Meaning |
|---|---|
| Chat | A session with no project |
| New chat | The action that starts a chat |
| Switch to chat | The project chip action that removes the project from a draft |
| Add project… | The + menu item that adds a project to a chat before its first prompt |
| Chat root | The folder that holds the chat folders (`.solus-chats` in a projects root) |
| New-chat marker | `NEW_CHAT_DIRECTORY`: the working directory of a chat that has no folder yet |

Do not use "Scratchpad", "Just chat", "workspace folder", or "chat folder" in
user-visible text.

## How a chat gets its folder

1. A draft for a new chat holds the new-chat marker as its working directory.
2. When the first prompt is sent, the client names the folder with
   `chatFolderIn(projectsRoot, sessionId)`. The projects root comes from the
   host's capabilities (`projectsBaseDirectory`), which the client already
   reads. The run then holds a real path, so files, links, and agent-file
   features work as for any folder.
3. The session handlers (`resolveChat`) make the folder. If the client sent the
   marker (it did not know the projects root yet, or it is a headless or mobile
   start), the host gives the chat `<projects root>/.solus-chats/<session id>`.
4. `resolveHomePath` refuses the marker. A chat that reaches a process without
   its folder fails loudly; it never runs in another folder.

A chat root inside a Git work tree is refused with `ChatUnavailableError`.

A session opened from a chat (⌘N, or a draft that inherits a run) is a new chat.
It never reuses the chat's folder. A chat is never saved as the last project.

## Contract

- New: `packages/contracts/src/chat.ts` (`CHAT_ROOT_NAME`, `NEW_CHAT_DIRECTORY`,
  `chatFolderIn`, `isChat`).
- Removed: `workspacePath` from `ServerCapabilities` and from `StartInfo`.
- Removed: the `lastChatServerId` device setting.
- New: the `chats` filter on `sessionRecordList` and on the Solus API
  `listSessions` query. It lists every chat of a host, for mobile.

## Clients

Desktop and web (shared Svelte UI):

- Draft headline: "What can I help with?" for a chat.
- No destination strip for a chat. **Add project…** and, with more than one
  host, **Run on…** are in the composer's + menu. A project draft keeps
  its strip, and its project menu ends with **Switch to chat**.
- The composer's + is a menu (Attach files, Take screenshot, Design mode, and
  Add project… and Run on… in a chat). It no longer widens on hover.
- Sidebar, breadcrumb, status bar, and automations name a chat "Chat", with a
  chat icon. All chats file under one sidebar group.
- Git refresh and slash commands do not read a folder for a new chat.
- **New chat** in the command palette and onboarding. Its host is the host of
  the current conversation, else the default machine. Run on moves a chat to
  any host.
- Removed: `SCRATCHPAD_LABEL`, the client `isChatFolder`, `chatFolderFor` and
  its background fetch, `scratchpadCheckout`, the Scratchpad place in the folder
  picker, the chat host rule (`chooseChatHost`), and the code that moved drafts
  onto the start payload's workspace folder.

Mobile:

- **Chats** on the host screen opens the chats of that host (the `chats` filter).
- **New chat** starts a chat in its own folder.

## Providers

Claude and Codex run a chat the same way: in the chat folder, with all their
tools. Both get one chat block in the shared host facts
(`runtime-instructions.ts`): the session is a chat, its folder is a private
scratch folder that is not a Git repository, and the agent does not mention its
path or run Git there.

## Keybinding

**New chat** is `⌘⌥N` (`Ctrl+Alt+N` on Windows and Linux), beside the
new-session family. The web uses the same combo. On iPad, `⌘N` in the Chats
list starts a new chat.
