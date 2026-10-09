/**
 * Banc PostgreSQL en mémoire (PGlite = PostgreSQL 17 compilé en WASM).
 *
 * Applique TOUTES les migrations du dépôt dans l'ordre, après des stubs
 * minimaux des objets Supabase (rôles anon/authenticated/service_role,
 * schéma auth). Les requêtes applicatives tournent ensuite sous le rôle
 * taply_app : RLS forcée exactement comme en staging.
 *
 * Limite : PGlite n'a qu'une connexion. Les transactions sont sérialisées
 * (file d'attente) — les tests de concurrence RÉELLE tournent contre
 * PostgreSQL (staging) via scripts/certification/.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import type { Pool, PoolClient, QueryResult } from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));

const SUPABASE_STUBS = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
  create schema auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text,
    email_confirmed_at timestamptz,
    raw_user_meta_data jsonb not null default '{}'::jsonb
  );
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
`;

export interface TestDb {
  readonly db: PGlite;
  /** Pool compatible `pg` : chaque transaction s'exécute sous taply_app. */
  readonly pool: Pool;
  /** Exécution superutilisateur (fixtures), hors RLS. */
  admin<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Transaction taply_app avec GUC posées, puis ROLLBACK (lecture/assertions). */
  asApp<T>(gucs: Record<string, string>, fn: (client: PoolClient) => Promise<T>, commit?: boolean): Promise<T>;
  close(): Promise<void>;
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

function toResult(raw: { rows: unknown[]; affectedRows?: number }): QueryResult {
  return {
    rows: raw.rows as never[],
    // node-postgres : rowCount = lignes renvoyées pour un SELECT, affectées sinon.
    rowCount: Math.max(raw.affectedRows ?? 0, raw.rows.length),
    command: '',
    oid: 0,
    fields: [],
  } as QueryResult;
}

export async function createTestDb(options: { upTo?: string } = {}): Promise<TestDb> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  for (const file of migrationFiles()) {
    if (options.upTo !== undefined && file > options.upTo) break;
    try {
      await db.exec(readFileSync(MIGRATIONS_DIR + file, 'utf8'));
    } catch (error) {
      throw new Error(`Migration ${file} : ${(error as Error).message}`);
    }
  }

  // File d'attente : PGlite n'a qu'une session, une transaction à la fois.
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };

  const rawQuery = async (sql: string, params?: unknown[]): Promise<QueryResult> => {
    const text = sql.trim().toLowerCase();
    if ((params === undefined || params.length === 0) && /^(begin|commit|rollback)$/.test(text)) {
      await db.exec(sql);
      if (text === 'begin') await db.exec('set local role taply_app');
      return toResult({ rows: [], affectedRows: 0 });
    }
    return toResult(await db.query(sql, params as unknown[] | undefined));
  };

  const makeClient = (release: () => void): PoolClient =>
    ({ query: rawQuery, release } as unknown as PoolClient);

  const pool = {
    connect: () =>
      new Promise<PoolClient>((resolveClient) => {
        void exclusive(
          () =>
            new Promise<void>((done) => {
              resolveClient(makeClient(() => done()));
            }),
        );
      }),
    query: (sql: string, params?: unknown[]) => exclusive(() => rawQuery(sql, params)),
    end: async () => undefined,
    on: () => pool,
  } as unknown as Pool;

  return {
    db,
    pool,
    admin: <T>(sql: string, params?: unknown[]) =>
      exclusive(async () => (await db.query(sql, params)).rows as T[]),
    asApp: <T>(gucs: Record<string, string>, fn: (client: PoolClient) => Promise<T>, commit = false) =>
      exclusive(async () => {
        await db.exec('begin');
        try {
          await db.exec('set local role taply_app');
          for (const [key, value] of Object.entries(gucs)) {
            await db.query('select set_config($1, $2, true)', [key, value]);
          }
          const result = await fn(makeClient(() => undefined));
          await db.exec(commit ? 'commit' : 'rollback');
          return result;
        } catch (error) {
          await db.exec('rollback');
          throw error;
        }
      }),
    close: () => db.close(),
  };
}
