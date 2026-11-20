import type { McpAppPermission, McpAppPermissions } from '@solus/contracts/mcp-apps'

/**
 * Browser features an app asks for in `_meta.ui.permissions`. An app frame has
 * none of them by default; a client gives a feature to the frame only after the
 * person approves it for that app, and only a feature it can deliver.
 */

const POLICY_FEATURES = {
  camera: 'camera',
  microphone: 'microphone',
  geolocation: 'geolocation',
  clipboardWrite: 'clipboard-write',
} satisfies Record<McpAppPermission, string>

/** What the app may do with each feature, as a verb and its object, so a list of them reads as one sentence. */
const ACTIONS = {
  camera: { verb: 'use', object: 'the camera' },
  microphone: { verb: 'use', object: 'the microphone' },
  geolocation: { verb: 'use', object: 'your location' },
  clipboardWrite: { verb: 'write to', object: 'the clipboard' },
} satisfies Record<McpAppPermission, { verb: string; object: string }>

/** The permissions an app asks for that this client can deliver, in a fixed order. */
export function mcpAppPermissionRequest(requested: McpAppPermissions | undefined, supported: readonly McpAppPermission[]): McpAppPermission[] {
  return supported.filter((permission) => requested?.[permission])
}

/** The frame's `allow` attribute. A bare feature name gives it to the app's own document only, not to frames it nests. */
export function mcpAppAllowAttribute(granted: readonly McpAppPermission[]): string {
  return granted.map((permission) => POLICY_FEATURES[permission]).join('; ')
}

/** The `hostCapabilities.sandbox.permissions` of what the person granted. */
export function mcpAppGrantedPermissions(granted: readonly McpAppPermission[]): McpAppPermissions {
  return Object.fromEntries(granted.map((permission) => [permission, {}]))
}

function listed(words: readonly string[]): string {
  return words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`
}

/**
 * The words of a request after "to": "write to the clipboard", "use the
 * camera and the microphone", "use the camera and your location, and write
 * to the clipboard". Features with one verb share it.
 */
export function mcpAppPermissionAction(permissions: readonly McpAppPermission[]): string {
  const objectsByVerb = new Map<string, string[]>()
  for (const permission of permissions) {
    const { verb, object } = ACTIONS[permission]
    objectsByVerb.set(verb, [...(objectsByVerb.get(verb) ?? []), object])
  }
  const clauses = [...objectsByVerb].map(([verb, objects]) => `${verb} ${listed(objects)}`)
  // A comma keeps "and" inside a clause apart from the "and" between clauses.
  const hasListInClause = [...objectsByVerb.values()].some((objects) => objects.length > 1)
  return clauses.length > 1 && hasListInClause ? `${clauses.slice(0, -1).join(', ')}, and ${clauses.at(-1)}` : listed(clauses)
}

/** The approval the person sees before a frame gets these features. */
export function mcpAppPermissionPrompt(title: string, permissions: readonly McpAppPermission[]) {
  return {
    title: `Allow ${title} to ${mcpAppPermissionAction(permissions)}?`,
    detail: 'The app reloads with this access. Your browser or system may ask you again.',
  }
}
