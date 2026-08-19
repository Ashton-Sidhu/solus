import { devFixtures } from './dev-fixture'
import type { DemoFixtures } from './types'

const modules = import.meta.glob('./data/*.json', { eager: true }) as Record<string, { default: unknown }>

function fixture<T>(name: string, fallback: T, isEmpty: (value: T) => boolean): T {
  const value = modules[`./data/${name}.json`]?.default as T | undefined
  return value === undefined || isEmpty(value) ? fallback : value
}

const emptyArray = (value: unknown[]): boolean => value.length === 0
const emptyObject = (value: object): boolean => Object.keys(value).length === 0

export const demoFixtures: DemoFixtures = {
  ...devFixtures,
  startInfo: fixture('start-info', devFixtures.startInfo, emptyObject),
  persistedTabs: fixture('persisted-tabs', devFixtures.persistedTabs, (value) => value.tabs.length === 0),
  sessions: fixture<DemoFixtures['sessions']>('sessions', devFixtures.sessions, emptyArray),
  plans: fixture<DemoFixtures['plans']>('plans', devFixtures.plans, emptyArray),
  works: fixture<DemoFixtures['works']>('works', devFixtures.works, emptyArray),
  pr: fixture('pr', devFixtures.pr, (value) => value.list.length === 0 && value.guide.sections.length === 0),
  tasks: fixture('tasks', devFixtures.tasks, (value) => value.list.tasks.length === 0),
  automations: fixture('automations', devFixtures.automations, (value) => value.list.length === 0),
  diffs: fixture<DemoFixtures['diffs']>('diffs', devFixtures.diffs, emptyObject),
  gitStatus: fixture<DemoFixtures['gitStatus']>('git-status', devFixtures.gitStatus, emptyObject),
  replayScript: fixture<DemoFixtures['replayScript']>('replay-script', devFixtures.replayScript, emptyArray),
}
