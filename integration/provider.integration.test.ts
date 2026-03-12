import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { Client, Pool } from '@middle-management/pglite-pg-adapter';
import { OpenFeature, ProviderEvents } from '@openfeature/server-sdk';
import { PostgresProvider } from '../src/index.ts';

const migration = readFileSync(new URL('../migration.sql', import.meta.url), 'utf8');

describe('Integration: full lifecycle', () => {
  it('initialize → insert → ConfigurationChanged → evaluate', async () => {
    const pglite = new PGlite();
    const pool = new Pool({ pglite });
    await pglite.exec(migration);

    // Insert initial flag before provider starts
    await pool.query(`
      INSERT INTO openfeature.feature_flags (flag_key, flag_type, default_variant)
      VALUES ('my-flag', 'boolean', 'on')
    `);
    await pool.query(`
      INSERT INTO openfeature.flag_variants (flag_key, variant, flag_type, value)
      VALUES ('my-flag', 'on', 'boolean', 'true'),
             ('my-flag', 'off', 'boolean', 'false')
    `);

    const provider = new PostgresProvider({
      pool: pool as any,
      syncIntervalMs: 60_000_000,
      createClient: () => new Client({ pglite }) as any,
    } as any);

    await OpenFeature.setProviderAndWait('test', provider);
    const client = OpenFeature.getClient('test');

    // Evaluate initial value
    const initial = await client.getBooleanValue('my-flag', false);
    assert.equal(initial, true);

    // Listen for configuration change
    const changed = new Promise<void>(resolve => {
      client.addHandler(ProviderEvents.ConfigurationChanged, () => resolve());
    });

    // Update the flag — triggers NOTIFY
    await pool.query(`
      UPDATE openfeature.feature_flags SET default_variant = 'off' WHERE flag_key = 'my-flag'
    `);

    // Wait for the ConfigurationChanged event
    await changed;

    // Evaluate updated value
    const updated = await client.getBooleanValue('my-flag', true);
    assert.equal(updated, false);

    // Cleanup
    await OpenFeature.clearProviders();
    await pool.end();
    await pglite.close();
  });

  it('AsyncDisposable cleanup is idempotent', async () => {
    const pglite = new PGlite();
    const pool = new Pool({ pglite });
    await pglite.exec(migration);

    const provider = new PostgresProvider({
      pool: pool as any,
      syncIntervalMs: 60_000_000,
      createClient: () => new Client({ pglite }) as any,
    } as any);

    await provider.initialize();

    // Double dispose should not throw
    await provider[Symbol.asyncDispose]();
    await provider[Symbol.asyncDispose]();

    await pool.end();
    await pglite.close();
  });
});
