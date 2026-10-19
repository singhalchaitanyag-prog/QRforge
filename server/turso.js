// Connects to a Turso database over HTTPS. Used by the Node server and the maintenance scripts.
// (The Cloudflare Worker imports the web build of the same client directly.)
import { createClient } from '@libsql/client';

export function connectTurso({ url, authToken }) {
  return createClient({ url: String(url).replace(/^libsql:/, 'https:'), authToken });
}
