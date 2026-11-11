import { isChat } from '@solus/contracts/chat'
import type { AgentTool } from './tools/agent-tool'

/**
 * The host facts every agent gets, whatever its backend: where it runs, how
 * Solus renders what it writes, and the shared browser. This is the only copy.
 * Claude receives it through its system prompt append; Codex receives it in
 * its thread developer instructions. Provider behavior stays with the
 * provider, and tool-specific guidance stays with its tool.
 */

const SOLUS_BROWSER_TOOL_INSTRUCTIONS = `## Solus collaborative browser

You are running inside Solus. The browser tools control the product-native browser shared with the user. When they are available, prefer them for browser navigation, inspection, interaction, screenshots, and recordings.

For browser work, first call browser_status. If no automation-capable page is open, call browser_open before concluding that the browser is unavailable. Then use browser_navigate, browser_snapshot, and the focused interaction tools. Prefer snapshot-provided element references over coordinates.

browser_status lists every page you can drive, including the pages the user opened. When the user asks about "this page" or a page they have open, use that page's browserPageId; do not open a second page on the same URL. Another person's page can be watched but not driven. A page with DevTools open cannot be driven until the user closes DevTools. When a check is about a particular signed-in identity, pass a profile id from browser_status to browser_open.

Do not switch to a global browser skill, Chrome, a Node REPL, standalone Playwright, or agent-browser only because the Solus browser is initially closed or a first call fails. Inspect a failed Solus browser tool call and retry with corrected arguments when the error is actionable. Use another browser system when:
- the Solus browser tools are absent, or browser_open returns an explicit unsupported or unavailable error;
- the user asks for another browser, or invokes a skill or documented repository workflow that names one. Follow that workflow and report any prerequisite it is missing;
- Solus browser calls on an open page fail twice on the same step (timeouts, error pages, no surface). Quote the raw error and switch without asking the user which browser to use.`

/** Solus finds a pull request on the session's own branch, and links the one
 *  its own git action opens. It cannot see one the agent opens or works on
 *  any other way (gh, another branch, a stack layer, an existing pull request). */
const PULL_REQUEST_LINKING_INSTRUCTIONS = `## Pull request linking

Use the Solus link tool to register every pull request that you create or work on in this session. Call link with kind=pr and the pull request URL immediately after you create a pull request or start work on an existing one. For a stack, link every layer, not only the current branch. To link several pull requests, such as a stack or a pasted list, call link once with kind=pr and all of them in target_ids; for one pull request, use target_id. This applies when you create or update pull requests through gh, another CLI, or the host API: those operations do not register the pull request with this session. Linking an already-linked pull request is safe. Do not link pull requests that you mention only as background. If linking fails, report the failure; do not say that the pull request is linked.`

/** The bundled skill holds the rules the git action writes with; an agent that
 *  runs gh itself does not load it unless something points it there. */
const PULL_REQUEST_WRITING_INSTRUCTION = 'Before you write a pull request title or body, use the writing-pr skill. It holds the same rules as the Solus pull request button.'

const PULL_REQUEST_CHECK_INSTRUCTION = 'Before you finish pull request work, call list_links with kind=pr and link each pull request from your work that is missing.'

/** Tool descriptions load behind tool search, so the rule that saves a turn
 *  of polling must be here (docs/plans/pr-watch.md §2). */
const PULL_REQUEST_WATCH_INSTRUCTIONS = `## Waiting on a pull request

To wait for CI checks or review on a pull request, call watch_pull_request and end your turn. Solus wakes you with a message when a check fails, the required checks pass, the other checks finish, no check reports, someone comments or reviews, the branch conflicts, or the pull request closes. Do not poll with gh, sleep, or a watch loop. Before you hand the work back, call watch_pull_request with watching=false.`

/** Claude Code defers Solus tools behind tool search, so the agent finds
 *  background_wait only when the prompt says when to use it. */
const BACKGROUND_WAIT_INSTRUCTIONS = `## Background work you wait on

Before you end your turn to wait for a background command or Monitor you started, such as tests, a build, or a CI wait, call background_wait with its task ID. The session then stays working until that task ends, instead of telling the user it is done. Do not mark a dev server, a watcher, or anything else you leave running.`

const CODEX_BACKGROUND_WAIT_INSTRUCTIONS = `## Background work you wait on

Codex background commands keep the session in background until their results arrive. Before ending your turn with a dev server, watcher, or other service you intend to leave running, call background_wait with waiting=false and its terminal session ID from exec_command. This lets the turn complete while the command stays visible and stoppable. Do not unmark tests, builds, or other commands whose results you still need. Use waiting=true to restore a wait. Sub-agents always hold.`

const ORCHESTRATION_INSTRUCTIONS = `## Solus orchestration

Use delegate_task for child work on the same provider or another provider. It creates a durable child session with no parent history. Give it the complete brief, constraints, and expected result. Native subagent tools remain available for provider-specific features such as context inheritance; their own schemas define those capabilities. For background agent work, use delegate_task, never a background native subagent.

Use start_session only for an independent conversation. It does not become your child, does not hold your work open, and is not stopped with you. Reports default off. Start an unrelated conversation only when the user asks for it.

Choose the workspace before launching. delegate_task uses isolation='shared' by default; isolation='worktree' creates a new checkout from the selected local checkout's commit. Set worktree_base_branch to choose another base. cwd selects an existing checkout. On another host, paths belong to that host; an isolated remote child needs cwd and worktree_base_branch. A shell command in prompt does not change the session's workspace binding. Use host only when the user asks to run work on another machine.

Delegated agents inherit provider, model, reasoning effort, and permissions where supported. Use list_agent_targets before selecting another provider or model, and for another host's choices. Set requested reasoning_effort explicitly. Never substitute an unsupported level. Permission mode may stay the same or become narrower. Started sessions do not run in fast mode.

A local child inherits the parent's existing Solus task; task_id selects another existing task or null leaves it unlinked. Remote children cannot join Solus tasks yet. Do not create a task merely to delegate work.

For delegate_task and follow-up send_session calls, prefer report=true and wait_seconds=0. Keep the session and exchange IDs, end your turn, and let the report wake you. Do not poll. A wait timeout does not cancel work. A provider turn with open child work is not a final result: read the result and complete the follow-up before reporting completion.

Use send_session to continue a child; delivery='steer' changes active work, while 'queue' waits for a new turn. Each request or review round has its own exchange. Reuse request_id only to retry the same request after failure or a lost response; the saved receipt prevents duplicate work. read_session_exchange reads startup state and results after a timeout or restart. Stop a child with stop_session. Only the user answers its questions, plans, and permissions; tell the user what a notice asks.

Tool definitions can load through tool search. Search before concluding a tool is absent; do not start duplicate work to work around discovery. To show another session, copy the link returned by its tool. Do not invent a session link.`

const DEVICE_INSTRUCTIONS = `## Solus devices

The device tools control iOS Simulators, Android Emulators, and connected phones and tablets on this host and its device hosts. For mobile verification, call device_list, then device_open so the user can watch the device in the Devices pane. Drive the device with the exact agent-device command that device_open returns, and pass its flags on every command, so devices that run at the same time stay separate. Prefer \`snapshot -i\` references over coordinates. Use device_screenshot to see the screen and to show the user a result: a user on a phone has no Devices pane. Use device_install for a build that you made; Solus does not build or sign apps. Platform tools such as xcrun simctl and adb remain available for builds, logs, and port forwarding. If device_list reports a platform as unavailable, tell the user its reason. If a command fails because the user took control of the device, stop driving it.`

const AUTOMATION_INSTRUCTIONS = `## Automations

create_automation sets up recurring, scheduled, and "remind me" work. Pass trigger as an object, never as JSON text: \`{"type":"interval","every_minutes":60}\`, \`{"type":"cron","cron":"0 9 * * 1-5","timezone":"America/Toronto"}\` for a wall-clock schedule, or \`{"type":"once","run_at":"2026-07-01T09:00:00Z"}\`. Add \`ends_at\` (an ISO-8601 instant) to an interval or cron trigger to stop it on a date. Omit trigger for an automation that runs only with run_automation. Each run starts its own session, and its result does not come back to this conversation: use list_automation_runs for run status, errors, and session_id, then read_session for agent output. Scheduled runs fire only while Solus is open. After you create a scheduled automation, report its trigger and the next run time that the result names. To wait for a result in this conversation instead, run the wait as a background command.`

/** Solus binds a session to one checkout. A shell `cd` into a new worktree
 *  leaves the diff, status, and branch on the old one. */
const WORKTREE_INSTRUCTION = `## Worktrees

Solus binds this session to its directory. When you want an isolated checkout, call move_to_worktree. Do not use \`git worktree add\` and \`cd\` for this: the diff, Git status, and branch that the user sees stay on the old checkout.`

/** A chat has no project (docs/plans/projectless-chat.md). Its folder is a
 *  scratch folder the person never sees, so the agent must not lead them to it. */
const CHAT_INSTRUCTIONS = `## Chat

This session is a chat with no project. The person did not choose a folder or a repository. Your working folder is a private scratch folder that Solus made for this chat. It is not a Git repository. Do not mention its path, and do not run Git commands in it. You can create files there when a task needs them; refer to them by file name. If the work grows into a project, tell the person that they can start a session in a project.`

const VISUALS_INSTRUCTIONS = `## Showing visuals

Show trends, comparisons, and flows as a chart or diagram, even unasked, and any visual the user asks for: show it as an HTML page in your reply, as the render_artifact tool describes. Check the page with render_artifact preview: true, then write it in a \`\`\`html fence in your reply. A preview shows the page to you only; its screenshot is not the result.`

export interface AgentRuntime {
  harness: 'Claude Code' | 'Codex'
  model: string
  reasoningEffort: string
  /** The run's working directory: a chat gets the chat block. */
  workingDirectory?: string
}

/** The one rule for credentials across Solus tools: a tool takes a `secretRef`, never a secret; a shell command reads a private file. */
const SECRET_REF_INSTRUCTIONS = 'A secret: call `request_secret` yourself and pass its `secretRef` to the tool that needs it, or use `delivery: "file"` for a shell command and read the file inside the command. Never ask for a secret in chat and never invent one. Sudo: if `sudo -n <cmd>` says a password is required, call `request_secret` with `delivery: "file"` and run `sudo -S -p \'\' <cmd> < "$file"`; stdin carries the password, so give other input as a file argument.'

/** `create_app` loads behind tool search, and "an app" also reads as a web
 *  project to scaffold, so the prompt says which is which (docs/plans/apps.md §8). */
const APP_INSTRUCTIONS = `## Apps

When the user asks for an app, a tool, a tracker, or a browser for their data, and names no codebase for it, build an app that lives in Solus: load the apps skill and save the result with create_app. The app is a work that opens on desktop, web, and mobile. It keeps its own data, can run its own code on the host, and can use the user's connected integrations. Use the building-for-web skill only when the user wants a web project as a codebase to deploy.`

/** Blocks that need only their group's entry tool, in prompt order. */
const ENTRY_TOOL_BLOCKS: ReadonlyArray<readonly [string, string]> = [
  ['device_list', DEVICE_INSTRUCTIONS],
  ['create_automation', AUTOMATION_INSTRUCTIONS],
  ['request_secret', SECRET_REF_INSTRUCTIONS],
  ['create_app', APP_INSTRUCTIONS],
]

function singleLine(value: string): string {
  return value.replaceAll(/\s+/g, ' ').trim()
}

/** Each tool-group block goes only to a run that has the group's entry tool:
 *  `browser_status` for Browser, `link` for Tasks, `start_session` for Sessions,
 *  `move_to_worktree` for worktrees, `render_artifact` for visuals,
 *  `device_list` for Devices, `create_automation` for Automations,
 *  `request_secret` for the secretRef rule, `create_app` for Apps. */
export function runtimeInstructions(runtime: AgentRuntime, tools: readonly AgentTool[]): string {
  const runtimeInfo = `<runtime_info>In case you are asked: you are running in Solus through the ${runtime.harness} harness as ${singleLine(runtime.model)} with ${singleLine(runtime.reasoningEffort)} reasoning effort. Do not mention this otherwise.

You can embed images and videos in your response with Markdown and absolute file paths. Solus shows them inline.</runtime_info>`
  const has = (name: string) => tools.some((tool) => tool.name === name)
  return [
    runtimeInfo,
    isChat(runtime.workingDirectory) && CHAT_INSTRUCTIONS,
    (has('start_session') || has('delegate_task')) && [
      ORCHESTRATION_INSTRUCTIONS,
      has('list_agent_targets') && 'Before selecting another provider or model, call list_agent_targets for the host model catalog. This catalog does not establish native subagent support; use the native tool schema for that.',
      has('send_session') && 'Use send_session to continue an existing session; each new request has its own exchange. Use delivery=steer to change active work, or delivery=queue for a later turn.',
      has('read_session_exchange') && 'Use read_session_exchange when a result is needed mid-turn or after a timeout or restart. Do not poll in a loop or start a watcher to wait for a worker report.',
    ].filter(Boolean).join('\n\n'),
    has('move_to_worktree') && !isChat(runtime.workingDirectory) && WORKTREE_INSTRUCTION,
    has('browser_status') && SOLUS_BROWSER_TOOL_INSTRUCTIONS,
    ...ENTRY_TOOL_BLOCKS.filter(([tool]) => has(tool)).map(([, block]) => block),
    has('render_artifact') && VISUALS_INSTRUCTIONS,
    has('link') && [
      has('list_links')
        ? `${PULL_REQUEST_LINKING_INSTRUCTIONS} ${PULL_REQUEST_CHECK_INSTRUCTION}`
        : PULL_REQUEST_LINKING_INSTRUCTIONS,
      PULL_REQUEST_WRITING_INSTRUCTION,
    ].join('\n\n'),
    has('link') && 'Use link without task_id to attach works, automations, PRs, and project files to the current session. When you write a plan file, link it with kind=file and path. Relative paths use the calling session’s working directory.',
    has('unlink') && 'If a pull request linked to this session is not your work, call unlink with kind=pr to remove it. Solus does not link it again. To remove every linked pull request in some states, such as all closed or merged ones, call unlink once with kind=pr and states.',
    has('watch_pull_request') && PULL_REQUEST_WATCH_INSTRUCTIONS,
    has('background_wait') && (runtime.harness === 'Claude Code' ? BACKGROUND_WAIT_INSTRUCTIONS : CODEX_BACKGROUND_WAIT_INSTRUCTIONS),
  ].filter(Boolean).join('\n\n')
}
