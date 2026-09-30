import { z } from 'zod'
import { solusApiOperations } from './operations'
import { workspaceActivityListSchema, workspaceErrorSchema, workspaceIdSchema } from './schemas'

/** Response schemas several operations answer, written once under `components.schemas`. */
const sharedResponses = new Map<z.ZodType, string>([[workspaceActivityListSchema, 'ActivityList']])

/** Generated from the same schemas and route metadata used by the server and client. */
export function solusApiOpenApi() {
  const jsonSchema = (schema: z.ZodType) => {
    const { $schema: _dialect, ...document } = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output' })
    return document
  }
  const entries = Object.entries(solusApiOperations).map(([operationId, operation]) => {
    const path = '/v1' + operation.path.replace(/:([A-Za-z]+)/g, '{$1}')
    const query = jsonSchema(operation.query)
    const parameters = [
      ...[...operation.path.matchAll(/:([A-Za-z]+)/g)].map(match => ({ name: match[1], in: 'path', required: true,
        schema: match[1] === 'insightId' ? { type: 'string', minLength: 1, maxLength: 1024 } : jsonSchema(workspaceIdSchema) })),
      ...Object.entries(query.properties ?? {}).map(([name, schema]) => ({ name, in: 'query', required: false, schema })),
      ...('idempotent' in operation ? [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 16, maxLength: 128 } }] : []),
      ...('conditional' in operation ? [{ name: 'If-Match', in: 'header', required: true, schema: { type: 'string', pattern: '^"[^"\\r\\n]+"$' } }] : []),
    ]
    if (operationId === 'getWork') parameters.push({ name: 'If-None-Match', in: 'header', required: false, schema: { type: 'string' } })
    const success = { description: 'Success' }
    if ('response' in operation) {
      const shared = sharedResponses.get(operation.response)
      Object.assign(success, { content: { 'application/json': { schema: shared ? { $ref: '#/components/schemas/' + shared } : jsonSchema(operation.response) } } })
    }
    const definition = {
      operationId, parameters,
      security: operationId === 'openApi' ? [] : [{ bearerAuth: [] }],
      responses: { [operation.status]: success,
        ...Object.fromEntries([400,401,403,404,409,412,413,429,500,503].map(status => [status, { description: 'Request failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }])) },
    }
    if (operationId === 'getWork') Object.assign(definition.responses, { 304: { description: 'Unchanged. No response body.' } })
    if ('scope' in operation) Object.assign(definition, { 'x-required-scope': operation.scope })
    if ('body' in operation) Object.assign(definition, { requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(operation.body) } } } })
    return { path, method: operation.method, definition }
  })
  return {
    openapi: '3.1.1', info: { title: 'Solus Workspace API', version: '1.0.0' },
    paths: Object.fromEntries([...new Set(entries.map(entry => entry.path))].map(path => [path, Object.fromEntries(entries.filter(entry => entry.path === path).map(entry => [entry.method, entry.definition]))])),
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'Exchange a verified source credential at /v1/auth/session. Resource requests use the returned short-lived credential.' } }, schemas: { Error: jsonSchema(workspaceErrorSchema),
      ...Object.fromEntries([...sharedResponses].map(([schema, name]) => [name, jsonSchema(schema)])) } },
  }
}
