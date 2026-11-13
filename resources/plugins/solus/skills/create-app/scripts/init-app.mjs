import { cp } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initArtifact } from '../../visual-artifacts/scripts/init-artifact.mjs'

// An app project is the artifact project of the visual-artifacts skill (its
// build, its `@solus/app` modules, its tsconfig) with this skill's starter app
// on top. Both skills ship in the same plugin, so there is one bundler and one
// copy of the modules: the host builds every app with that bundler.
export async function initApp(directory, { install = true } = {}) {
  const projectDirectory = await initArtifact(directory, { install: false })
  const skillDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  await cp(resolve(skillDirectory, 'assets/starter'), projectDirectory, { recursive: true, force: true })
  if (install) {
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: projectDirectory, stdio: 'inherit' })
  }
  return projectDirectory
}

// Compare real paths: the skill is often reached through a symlink (~/.solus/plugins),
// and a mismatch would skip the command without a word.
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2)
  if (args.length < 1 || args.length > 2 || (args[1] && args[1] !== '--no-install') || args[0].startsWith('--')) {
    console.error('Usage: node init-app.mjs <new-directory> [--no-install]')
    process.exitCode = 1
  } else {
    try {
      const directory = await initApp(args[0], { install: args[1] !== '--no-install' })
      console.log(`App source: ${directory}`)
      console.log('It is the Notes starter app. Change app.ts, migrations/, and src/ into the app the user asked for, then check it with preview_app.')
    } catch (error) {
      console.error(`App setup failed: ${error.message}`)
      console.error('Existing directories are never replaced. If installation failed, run npm install in the new directory to retry.')
      process.exitCode = 1
    }
  }
}
