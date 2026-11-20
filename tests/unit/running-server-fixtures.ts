import type { RunningServer } from '@solus/contracts/running-servers'

export function runningServer(serverId = 'server-1'): RunningServer {
  return {
    serverId,
    process: { pid: 123, name: 'node', workingDirectory: '/project/worktree/api' },
    location: { worktreePath: '/project/worktree', projectRoot: '/project', branch: 'feature' },
    startedBy: { kind: 'agent', sessionId: 'session-1' },
    endpoints: [{ endpointId: '3001', address: '127.0.0.1', port: 3001, url: 'http://127.0.0.1:3001/', response: { protocol: 'http', statusCode: 401, contentType: 'application/json', pageTitle: null } }],
    actions: { canStop: true },
  }
}

export function processFact(pid: number, fields: Partial<import('@solus/server/host/running-servers/processes').ProcessFacts> = {}): import('@solus/server/host/running-servers/processes').ProcessFacts {
  return { pid, parentPid: 10, groupId: pid, identity: `started-${pid}`, name: 'node', sessionId: 'session', terminalId: null, commandId: null, tagsRead: true, protected: false, ...fields }
}
