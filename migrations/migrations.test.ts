/**
 * For each `<from>-to-<to>.sql` in this directory, verifies that applying
 * `<from>.sql` + the migration produces a schema structurally identical to
 * applying `<to>.sql` from scratch.
 *
 * Both DBs are queried for tables, columns, constraints, indexes, triggers,
 * and routines; results are flattened to a canonical string and compared.
 */

import { PGlite } from "@electric-sql/pglite";
import { assertEquals } from "@std/assert";

const migrationsDir = new URL(".", import.meta.url);

async function dumpSchema(db: PGlite): Promise<string> {
  const queries: Record<string, string> = {
    columns: `
      SELECT table_name, column_name, data_type,
             character_maximum_length, is_nullable, column_default, udt_name
      FROM information_schema.columns
      WHERE table_schema = 'openfeature'
      ORDER BY table_name, ordinal_position
    `,
    primary_keys: `
      SELECT tc.table_name,
             array_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS cols
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        USING (constraint_schema, constraint_name, table_name)
      WHERE tc.constraint_schema = 'openfeature' AND tc.constraint_type = 'PRIMARY KEY'
      GROUP BY tc.table_name, tc.constraint_name
      ORDER BY tc.table_name, cols
    `,
    unique_constraints: `
      SELECT tc.table_name,
             array_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS cols,
             tc.nulls_distinct
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        USING (constraint_schema, constraint_name, table_name)
      WHERE tc.constraint_schema = 'openfeature' AND tc.constraint_type = 'UNIQUE'
      GROUP BY tc.table_name, tc.constraint_name, tc.nulls_distinct
      ORDER BY tc.table_name, cols
    `,
    foreign_keys: `
      SELECT tc.table_name,
             array_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS cols,
             ccu.table_name AS ref_table,
             array_agg(ccu.column_name ORDER BY kcu.ordinal_position) AS ref_cols,
             rc.update_rule, rc.delete_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        USING (constraint_schema, constraint_name, table_name)
      JOIN information_schema.referential_constraints rc
        USING (constraint_schema, constraint_name)
      JOIN information_schema.constraint_column_usage ccu
        USING (constraint_schema, constraint_name)
      WHERE tc.constraint_schema = 'openfeature' AND tc.constraint_type = 'FOREIGN KEY'
      GROUP BY tc.table_name, tc.constraint_name, ccu.table_name,
               rc.update_rule, rc.delete_rule
      ORDER BY tc.table_name, cols
    `,
    check_constraints: `
      SELECT tc.table_name, cc.check_clause
      FROM information_schema.check_constraints cc
      JOIN information_schema.table_constraints tc
        USING (constraint_schema, constraint_name)
      WHERE tc.constraint_schema = 'openfeature' AND tc.constraint_type = 'CHECK'
      ORDER BY tc.table_name, cc.check_clause
    `,
    triggers: `
      SELECT event_object_table AS table_name, event_manipulation,
             action_timing, action_orientation, action_statement
      FROM information_schema.triggers
      WHERE trigger_schema = 'openfeature'
      ORDER BY event_object_table, event_manipulation, action_statement
    `,
    routines: `
      SELECT routine_name, routine_definition, data_type
      FROM information_schema.routines
      WHERE routine_schema = 'openfeature'
      ORDER BY routine_name
    `,
    enums: `
      SELECT t.typname,
             array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE n.nspname = 'openfeature'
      GROUP BY t.typname
      ORDER BY t.typname
    `,
  };

  const parts: string[] = [];
  for (const [section, sql] of Object.entries(queries)) {
    const result = await db.query<Record<string, unknown>>(sql);
    parts.push(`== ${section} ==`);
    for (const row of result.rows) parts.push(JSON.stringify(row));
    parts.push("");
  }
  return parts.join("\n");
}

function adopt<T extends { close(): Promise<void> }>(value: T) {
  return {
    value,
    async [Symbol.asyncDispose]() {
      await value.close();
    },
  };
}

// Discover migrations and register a test per pair.
for (const entry of Deno.readDirSync(migrationsDir)) {
  const match = entry.name.match(/^(.+)-to-(.+)\.sql$/);
  if (!match) continue;
  const [, from, to] = match;
  Deno.test(`${entry.name}: ${from} + migration == fresh ${to}`, async () => {
    const fromSchema = Deno.readTextFileSync(
      new URL(`./${from}.sql`, migrationsDir),
    );
    const toSchema = Deno.readTextFileSync(
      new URL(`./${to}.sql`, migrationsDir),
    );
    const migration = Deno.readTextFileSync(
      new URL(`./${entry.name}`, migrationsDir),
    );

    await using migrated = adopt(new PGlite());
    await migrated.value.exec(fromSchema);
    await migrated.value.exec(migration);

    await using fresh = adopt(new PGlite());
    await fresh.value.exec(toSchema);

    assertEquals(
      await dumpSchema(migrated.value),
      await dumpSchema(fresh.value),
    );
  });
}
