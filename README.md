# @quad/openfeature-provider-postgres

A PostgreSQL-backed [OpenFeature](https://openfeature.dev/) provider for Deno.

## How it works

Flags are cached in memory. The cache is refreshed in two ways:

1. **LISTEN/NOTIFY** — schema triggers send a Postgres notification on every
   flag change; the provider re-syncs immediately (debounced).
2. **Periodic sync** — a jittered timer re-syncs as a fallback in case a
   notification is missed (e.g. during a connection drop).

Each provider instance holds one dedicated connection from the pool for
`LISTEN`. Size your pool accordingly.

## License

Apache-2.0
