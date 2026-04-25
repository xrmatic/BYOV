/**
 * Database client
 *
 * Thin wrapper around pg (node-postgres) for raw SQL queries,
 * plus a Supabase client for auth operations.
 */

'use strict';

const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');

let _pool = null;
let _supabase = null;

/**
 * Returns the singleton pg connection pool.
 * @returns {import('pg').Pool}
 */
function getPool() {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: true }
        : false,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    _pool.on('error', (err) => {
      console.error('[DB] Unexpected pool error:', err.message);
    });
  }
  return _pool;
}

/**
 * Returns the singleton Supabase admin client (service role key).
 * @returns {import('@supabase/supabase-js').SupabaseClient}
 */
function getSupabase() {
  if (!_supabase) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in environment.');
    }
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
  }
  return _supabase;
}

/**
 * Executes a parameterised SQL query.
 * @param {string}   text   – SQL with $1, $2, … placeholders
 * @param {any[]}    params – query parameters
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, params = []) {
  const pool = getPool();
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    return result;
  } catch (err) {
    console.error(`[DB] Query error (${Date.now() - start}ms):`, err.message, '\nSQL:', text);
    throw err;
  }
}

module.exports = { getPool, getSupabase, query };
