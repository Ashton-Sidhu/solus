// `bun lab build | run | up --cloud | down` — the Lab entry (docs/plans/multiplayer-sharing.md §8).
import { main } from '@solus/lab/cli'

process.exit(await main(process.argv.slice(2)))
