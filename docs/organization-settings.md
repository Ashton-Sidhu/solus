# Organization settings

Settings → Organization shows the settings of an organization that you are a member of. The page shows only when you are signed in to Solus.

## What each role can do

| Setting | Member | Owner |
| --- | --- | --- |
| Name | Read | Change |
| URL and your role | Read | Read |
| Members | Read the list | Read the list. **Invite people** and **Manage** open the Solus console. |
| Allow cloud hosts, allow personal hosts | Read | Change |
| Default packages and default setup script for new cloud hosts | Read | Change |
| Policy | Open Settings → Policy | Open Settings → Policy |
| Audit log and observability | Not shown | Open the Solus console |
| Leave organization | Open the Solus console | Open the Solus console |
| Delete organization | Not shown | Open the Solus console |

Solus Cloud checks the role again for each change. The client hides the owner controls only to show you what you can do.

When you belong to more than one organization, select the organization at the top of the page. This selection does not change the organization of the window.

## How a change is saved

- A name saves when you leave the field or push Enter.
- A switch saves at once.
- Packages save when you leave the field or push Enter. Separate the package names with spaces or commas.
- The setup script saves when you leave the field.

Each host rules change names the revision that you read. If another owner saved first, Solus shows their settings and tells you that your change was not saved. Make your change again.

## API

The page reads and writes `/v1/orgs/:organizationId/settings` on Solus Cloud (`packages/contracts/src/policy-api.ts`). `GET` is for members. `PATCH` is for owners. The statuses are the same as the policy routes: 403 for a person who is not a member or not an owner, 409 with the current settings, and 422 with the reason. Desktop sends the requests from the main process. Web sends them with the page's sign-in.

## Settings sidebar order

The settings sidebar uses the group order of T3 Code:

1. Preferences, with no heading: General, Appearance, Chat, Notifications, Keybindings, Voice.
2. Agents: Providers, Sessions, Agent profile, Tools, MCP, Skills, Devices.
3. Code: Source Control, Codebases, Tasks, Review companion.
4. Connections: Hosts, Integrations, Webhooks. Policy is here when you are signed out.
5. Organization, only when you are signed in: Organization, Policy.
6. More, with no heading: Host, Telemetry, Experimental.

The sidebar footer shows your account, or **Sign in**. It opens Account & sync.
