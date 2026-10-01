# Workspace API routes

Generated contract: [openapi.json](openapi.json).

| Method | Path | Operation |
| --- | --- | --- |
| POST | `/v1/auth/session` | `exchangeCredential` |
| GET | `/v1/capabilities` | `capabilities` |
| GET | `/v1/openapi.json` | `openApi` |
| GET | `/v1/tasks` | `listTasks` |
| POST | `/v1/tasks` | `createTask` |
| GET | `/v1/tasks/{taskId}` | `getTask` |
| PATCH | `/v1/tasks/{taskId}` | `updateTask` |
| DELETE | `/v1/tasks/{taskId}` | `deleteTask` |
| GET | `/v1/tasks/{taskId}/activity` | `listTaskActivity` |
| GET | `/v1/works` | `listWorks` |
| POST | `/v1/works` | `createWork` |
| GET | `/v1/works/search` | `searchWorks` |
| POST | `/v1/works/import` | `importWork` |
| GET | `/v1/works/{workId}` | `getWork` |
| PATCH | `/v1/works/{workId}` | `updateWork` |
| DELETE | `/v1/works/{workId}` | `deleteWork` |
| POST | `/v1/works/{workId}/publish` | `publishWork` |
| POST | `/v1/works/{workId}/pull` | `pullWorkUpstream` |
| POST | `/v1/works/{workId}/review-requests` | `requestWorkReview` |
| GET | `/v1/works/{workId}/activity` | `listWorkActivity` |
| GET | `/v1/sessions` | `listSessions` |
| GET | `/v1/sessions/search` | `searchSessions` |
| POST | `/v1/session-admissions` | `admitSession` |
| GET | `/v1/sessions/{sessionId}` | `getSession` |
| GET | `/v1/sessions/{sessionId}/messages` | `listSessionMessages` |
| GET | `/v1/sessions/{sessionId}/activity` | `listSessionActivity` |
| GET | `/v1/me/activity` | `listMyActivity` |
| GET | `/v1/insights` | `listInsights` |
| GET | `/v1/insights/{insightId}` | `getInsight` |
| GET | `/v1/insights/{insightId}/spans` | `getInsightSpans` |
