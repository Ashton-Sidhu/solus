import { defineConfig } from 'drizzle-kit'

// `bun run db:generate` (scripts/generate-db-migrations.ts) runs both configs.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema/sqlite.ts',
  out: './drizzle/sqlite',
})
