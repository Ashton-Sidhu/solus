import { cp, mkdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function initArtifact(directory, { install = true } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 22) {
    throw new Error('Node.js 22 or later is required.')
  }
  const projectDirectory = resolve(directory)
  const skillDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  await mkdir(projectDirectory)
  await cp(resolve(skillDirectory, 'assets/react'), projectDirectory, { recursive: true, force: false })
  await mkdir(resolve(projectDirectory, '.artifact'))
  await cp(resolve(skillDirectory, 'scripts/bundle-artifact.mjs'), resolve(projectDirectory, '.artifact/bundle-artifact.mjs'))
  await writeFile(resolve(projectDirectory, '.gitignore'), 'node_modules/\nbundle.html\n')
  if (install) {
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: projectDirectory, stdio: 'inherit' })
  }
  return projectDirectory
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length < 1 || args.length > 2 || (args[1] && args[1] !== '--no-install') || args[0].startsWith('--')) {
    console.error('Usage: node init-artifact.mjs <new-directory> [--no-install]')
    process.exitCode = 1
  } else {
    try {
      const directory = await initArtifact(args[0], { install: args[1] !== '--no-install' })
      console.log(`Artifact source: ${directory}`)
      console.log('Edit src/App.tsx and index.html, then run npm run bundle in that directory.')
    } catch (error) {
      console.error(`Artifact setup failed: ${error.message}`)
      console.error('Existing directories are never replaced. If installation failed, run npm install in the new directory to retry.')
      process.exitCode = 1
    }
  }
}
