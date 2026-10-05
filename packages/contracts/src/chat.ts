/**
 * A chat is a session with no project (docs/plans/projectless-chat.md). The host
 * runs each chat in a folder of its own, `<projects root>/.solus-chats/<id>`.
 * The folder's name is the only mark of a chat: every surface asks `isChat`, so
 * a client names a chat without asking its host anything.
 */
export const CHAT_ROOT_NAME = '.solus-chats'

/**
 * The working directory of a chat whose host has not made its folder yet. It is
 * not a path: the host replaces it with the chat's own folder before a process
 * sees it. `~` is the home folder and never means a chat. A client gives a chat
 * its folder when it sends the first prompt (`chatFolderIn`).
 */
export const NEW_CHAT_DIRECTORY = 'solus:new-chat'

const CHAT_ID = /^[A-Za-z0-9_-]+$/

/** The folder of one chat. The host names the projects root; this names the folder in it. */
export function chatFolderIn(projectsRoot: string, chatId: string): string {
  return `${projectsRoot.replace(/[\\/]+$/, '')}/${CHAT_ROOT_NAME}/${chatId}`
}

/** True for a new chat, the folder of a chat, and the folder that holds them. */
export function isChat(workingDirectory: string | null | undefined): boolean {
  if (!workingDirectory) return false
  if (workingDirectory === NEW_CHAT_DIRECTORY) return true
  const segments = workingDirectory.replace(/[\\/]+$/, '').split(/[\\/]/)
  const last = segments.at(-1) ?? ''
  if (last === CHAT_ROOT_NAME) return true
  return segments.at(-2) === CHAT_ROOT_NAME && CHAT_ID.test(last)
}
