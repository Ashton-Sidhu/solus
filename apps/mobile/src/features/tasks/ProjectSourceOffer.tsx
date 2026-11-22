import { useState } from 'react'
import { View } from 'react-native'
import type { TaskSource } from '@solus/contracts/task-sources'
import type { TaskSourceOptions } from '@solus/contracts/task-types'
import { SettingsSection } from '../settings/components/SettingsSection'
import { SettingsSwitchRow } from '../settings/components/SettingsSwitchRow'
import { TaskAction } from './task-controls'

type ProjectRepository = NonNullable<TaskSourceOptions['github']['projectRepositories']>[number]

const repositoryName = (repository: ProjectRepository) => `${repository.owner}/${repository.repo}`

/**
 * The repositories of the person's recent projects, offered in one step to a
 * person with no task source, as on desktop. A fork's original repository
 * starts off. Added, they are ordinary sources.
 */
export function ProjectSourceOffer({ repositories, onAdd }: {
  readonly repositories: readonly ProjectRepository[]
  readonly onAdd: (sources: TaskSource[]) => void
}) {
  const [choices, setChoices] = useState<ReadonlyMap<string, boolean>>(new Map())
  const isChosen = (repository: ProjectRepository) => choices.get(repositoryName(repository)) ?? !repository.isFork
  const chosen = repositories.filter(isChosen)
  return (
    <View className="gap-3">
      <SettingsSection
        title="Your projects"
        footer="Read issues from the repositories of your projects. A fork starts off: its original repository has many issues that are rarely yours."
      >
        {repositories.map((repository) => (
          <SettingsSwitchRow
            key={repositoryName(repository)}
            label={repositoryName(repository)}
            subtitle={repository.isFork ? 'Fork' : undefined}
            value={isChosen(repository)}
            onValueChange={(value) => setChoices(new Map(choices).set(repositoryName(repository), value))}
          />
        ))}
      </SettingsSection>
      <TaskAction
        disabled={chosen.length === 0}
        onPress={() => onAdd(chosen.map((repository): TaskSource => ({ kind: 'github-repo', owner: repository.owner, repo: repository.repo })))}
      >
        {chosen.length === 0 ? 'Select a repository' : `Add ${chosen.length} ${chosen.length === 1 ? 'repository' : 'repositories'}`}
      </TaskAction>
    </View>
  )
}
