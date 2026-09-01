/**
 * Production skills registry access. The e2e test build aliases this module to
 * tests/e2e/mock/skills-provider.ts (see electron.vite.config.ts) so the
 * networked skills.sh calls are replaced with deterministic fixtures and no
 * mock data ships in releases.
 */
export { searchSkills, installSkill } from './skills-cli'
