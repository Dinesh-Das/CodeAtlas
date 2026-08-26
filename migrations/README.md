# Database migrations

Runtime migrations are compiled with the package from `src/storage/migrations.ts` so an
installed CLI does not depend on loose SQL files. Each migration is versioned and applied
transactionally through the `schema_migrations` table.
