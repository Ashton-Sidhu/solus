import { defineConfig } from 'drizzle-kit'

// `bun run db:generate` (scripts/generate-db-migrations.ts) runs every config.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema/host.ts',
  out: './drizzle/host',
})
