# Workspace API routes

Generated contract: [openapi.json](openapi.json).

| Method | Path | Operation |
| --- | --- | --- |
| GET | `/v1/capabilities` | `capabilities` |
| GET | `/v1/openapi.json` | `openApi` |
| GET | `/v1/works` | `listWorks` |
| POST | `/v1/works` | `createWork` |
| POST | `/v1/works/{workId}/publish` | `publishWork` |
| POST | `/v1/works/{workId}/pull` | `pullWorkUpstream` |
| POST | `/v1/works/{workId}/review-requests` | `requestWorkReview` |
| POST | `/v1/works/import` | `importWork` |
| GET | `/v1/works/search` | `searchWorks` |
| GET | `/v1/works/{workId}` | `getWork` |
| PATCH | `/v1/works/{workId}` | `updateWork` |
| DELETE | `/v1/works/{workId}` | `deleteWork` |
| GET | `/v1/works/{workId}/activity` | `listWorkActivity` |
| GET | `/v1/sessions` | `listSessions` |
| GET | `/v1/sessions/search` | `searchSessions` |
| GET | `/v1/sessions/{sessionId}` | `getSession` |
| PATCH | `/v1/sessions/{sessionId}` | `updateSession` |
| POST | `/v1/session-admissions` | `admitSession` |
| POST | `/v1/sessions/{sessionId}/turns` | `admitSessionTurn` |
| GET | `/v1/sessions/{sessionId}/links` | `listSessionLinks` |
| GET | `/v1/sessions/{sessionId}/pull-requests` | `listSessionPullRequests` |
| PUT | `/v1/links` | `putLink` |
| DELETE | `/v1/links` | `deleteLink` |
| GET | `/v1/sessions/{sessionId}/messages` | `listSessionMessages` |
| GET | `/v1/sessions/{sessionId}/activity` | `listSessionActivity` |
| GET | `/v1/me/activity` | `listMyActivity` |
| GET | `/v1/me/notifications` | `listMyNotifications` |
| GET | `/v1/me/notifications/count` | `countMyNotifications` |
| POST | `/v1/me/notifications/{notificationId}/read` | `setMyNotificationRead` |
| POST | `/v1/me/notifications/{notificationId}/archive` | `setMyNotificationArchived` |
| GET | `/v1/insights` | `listInsights` |
| GET | `/v1/insights/{insightId}` | `getInsight` |
| GET | `/v1/insights/{insightId}/spans` | `getInsightSpans` |

The API has no task record routes. GitHub and Jira own every task
([tasks](../tasks.md)), and the API stores only what Solus attaches to a task.
`PUT /v1/links` and `DELETE /v1/links` link a task or a session to another
record; a task is named by its task key.
