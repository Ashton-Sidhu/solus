import { defineConfig } from 'drizzle-kit'

// `bun run db:generate` (scripts/generate-db-migrations.ts) runs both configs.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/postgres.ts',
  out: './drizzle/postgres',
})
