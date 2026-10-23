import { z } from 'zod'
import { GoogleSolusServer } from './google'
import { solusTool, vendorJson } from './solus-server'

/**
 * Google Tasks as a Solus MCP server (docs/plans/mcp-integrations.md §13.6):
 * Google publishes no usable Tasks MCP server. The tools list task lists and
 * their tasks, and create, change, complete, and delete a task over the Tasks
 * API v1. The scope is sensitive, not restricted.
 */

const API = 'https://tasks.googleapis.com/tasks/v1'

/** `tasks` reads and writes task lists and tasks; there is no narrower scope that writes. */
export const GOOGLE_TASKS_SCOPES = ['https://www.googleapis.com/auth/tasks'] as const

const taskListId = z.string().min(1).default('@default').describe('A task list id from list_task_lists; `@default` is the user\'s default list.')
const taskId = z.string().min(1).describe('A task id from list_tasks.')
const dueDate = z.string().min(1).describe('An RFC 3339 time, such as 2026-10-23T00:00:00Z. Google keeps only the date; the time is dropped.')

function taskUrl(list: string, task: string): string {
  return `${API}/lists/${encodeURIComponent(list)}/tasks/${encodeURIComponent(task)}`
}

export const googleTasksServer = new GoogleSolusServer({
  id: 'google-tasks',
  name: 'Google Tasks',
  description: 'Task lists and tasks in Google Tasks.',
  domain: 'tasks.google.com',
  icon: 'https://ssl.gstatic.com/images/branding/product/2x/tasks_48dp.png',
  categories: ['productivity'],
  hosts: ['tasks.googleapis.com'],
  scopes: GOOGLE_TASKS_SCOPES,
  tools: [
    solusTool({
      name: 'list_task_lists',
      description: 'The user\'s task lists, with their ids and titles.',
      input: z.object({}),
      readOnly: true,
      destructive: false,
      run: async (_input, { fetch }) => vendorJson(await fetch(`${API}/users/@me/lists?maxResults=100&fields=items(id,title,updated)`)),
    }),
    solusTool({
      name: 'list_tasks',
      description: 'The tasks in one task list. Subtasks name their parent.',
      input: z.object({
        taskListId,
        showCompleted: z.boolean().default(false),
        showHidden: z.boolean().default(false).describe('Also show hidden tasks. Tasks completed in Google\'s own apps are hidden, so set it with showCompleted to see them.'),
        dueMin: z.string().optional().describe('Only tasks due on or after this RFC 3339 time.'),
        dueMax: z.string().optional().describe('Only tasks due before this RFC 3339 time.'),
        maxResults: z.number().int().min(1).max(100).default(100),
        pageToken: z.string().optional().describe('The nextPageToken of an earlier call, for the next page.'),
      }),
      readOnly: true,
      destructive: false,
      run: async (input, { fetch }) => {
        const params = new URLSearchParams({
          showCompleted: String(input.showCompleted),
          showHidden: String(input.showHidden),
          maxResults: String(input.maxResults),
          fields: 'nextPageToken,items(id,title,notes,status,due,completed,parent,position,updated,webViewLink)',
        })
        if (input.dueMin) params.set('dueMin', input.dueMin)
        if (input.dueMax) params.set('dueMax', input.dueMax)
        if (input.pageToken) params.set('pageToken', input.pageToken)
        return vendorJson(await fetch(`${API}/lists/${encodeURIComponent(input.taskListId)}/tasks?${params}`))
      },
    }),
    solusTool({
      name: 'create_task',
      description: 'Create a task, at the top of its list or first under its parent.',
      input: z.object({
        taskListId,
        title: z.string().min(1),
        notes: z.string().optional(),
        due: dueDate.optional(),
        parent: z.string().optional().describe('A task id, to make this a subtask of that task.'),
      }),
      readOnly: false,
      destructive: false,
      run: async ({ taskListId: list, parent, ...fields }, { fetch }) => {
        const params = new URLSearchParams()
        if (parent) params.set('parent', parent)
        return vendorJson(await fetch(`${API}/lists/${encodeURIComponent(list)}/tasks?${params}`, { method: 'POST', body: JSON.stringify(fields) }))
      },
    }),
    solusTool({
      name: 'update_task',
      description: 'Change a task\'s title, notes, or due date. Fields not given stay as they are.',
      input: z.object({
        taskListId,
        taskId,
        title: z.string().min(1).optional(),
        notes: z.string().optional().describe('An empty string clears them.'),
        due: dueDate.optional(),
      }),
      readOnly: false,
      destructive: false,
      run: async ({ taskListId: list, taskId: task, ...fields }, { fetch }) =>
        vendorJson(await fetch(taskUrl(list, task), { method: 'PATCH', body: JSON.stringify(fields) })),
    }),
    solusTool({
      name: 'complete_task',
      description: 'Mark a task completed, or with reopen, mark it not completed again.',
      input: z.object({ taskListId, taskId, reopen: z.boolean().default(false) }),
      readOnly: false,
      destructive: false,
      run: async (input, { fetch }) => {
        // Reopening also clears the completion time, which Google otherwise keeps.
        const body = input.reopen ? { status: 'needsAction', completed: null } : { status: 'completed' }
        return vendorJson(await fetch(taskUrl(input.taskListId, input.taskId), { method: 'PATCH', body: JSON.stringify(body) }))
      },
    }),
    solusTool({
      name: 'delete_task',
      description: 'Delete a task and its subtasks.',
      input: z.object({ taskListId, taskId }),
      readOnly: false,
      destructive: true,
      run: async (input, { fetch }) => {
        const response = await fetch(taskUrl(input.taskListId, input.taskId), { method: 'DELETE' })
        if (!response.ok) await vendorJson(response)
        return { deleted: input.taskId }
      },
    }),
    solusTool({
      name: 'create_task_list',
      description: 'Create a task list.',
      input: z.object({ title: z.string().min(1) }),
      readOnly: false,
      destructive: false,
      run: async (input, { fetch }) => vendorJson(await fetch(`${API}/users/@me/lists`, { method: 'POST', body: JSON.stringify({ title: input.title }) })),
    }),
  ],
})
