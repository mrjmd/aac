#!/usr/bin/env npx tsx
/**
 * Env drift check: for each Vercel project, compare the env var names its
 * code reads (the app plus every workspace package it depends on) against
 * the names set in Vercel production. Prints names only, never values.
 *
 * Read-only. The only Vercel call is `vercel env ls production --format json`
 * (which returns names and metadata, no values). Needs a logged-in Vercel CLI.
 *
 * Usage (repo root):
 *   npx tsx tools/src/env-check.ts              # every project
 *   npx tsx tools/src/env-check.ts field agent  # just these (Vercel project names)
 *
 * Collection is static and heuristic:
 *   - process.env.X, process.env['X'], const { X, Y: y } = process.env
 *   - in files that read env dynamically (process.env[name], const env =
 *     process.env), also env.X and every UPPER_SNAKE string literal
 *     (requireEnv('X'), need-lists). That can pull in a non-env constant;
 *     treat "set but unused" as a prompt to look, not a verdict.
 * Tests and build output are skipped. Vercel/Node system vars are ignored.
 * A name read as `process.env.X || ...` / `?? ...` is reported as having a
 * fallback. Exit code 1 when anything without a fallback is missing or
 * anything set is unused.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const TEAM_ID = 'team_xO1tybQ8vFTha22hn8eaHc9v';

const PROJECTS: Array<{ vercel: string; dir: string }> = [
  { vercel: 'aac-middleware-monorepo', dir: 'apps/middleware' },
  { vercel: 'aac-worker-monorepo', dir: 'apps/worker' },
  { vercel: 'field', dir: 'apps/field' },
  { vercel: 'marketing', dir: 'apps/marketing' },
  { vercel: 'agent', dir: 'apps/agent' },
  { vercel: 'aac-command-center', dir: 'apps/command-center' },
];

/** Read by an SDK rather than our code: counts as used when the dependency is present. */
const SDK_ENV: Record<string, string[]> = { '@vercel/blob': ['BLOB_READ_WRITE_TOKEN'] };

/** Provided by the platform or runtime, never set by hand. */
const SYSTEM = /^(VERCEL|VERCEL_.+|NODE_ENV|CI|TZ|NEXT_RUNTIME|NEXT_PHASE|PORT|HOME|PATH|TURBO_.+|NX_.+)$/;

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', '__tests__', 'coverage', 'drizzle']);
const SRC_EXT = /\.(ts|tsx|mts|js|mjs)$/;
const TEST_FILE = /\.(test|spec)\.[a-z]+$/;

const ROOT = findRoot(process.cwd());

function findRoot(start: string): string {
  let d = resolve(start);
  while (!existsSync(join(d, 'pnpm-workspace.yaml'))) {
    const up = resolve(d, '..');
    if (up === d) throw new Error('run from inside the monorepo');
    d = up;
  }
  return d;
}

interface Pkg {
  name: string;
  dependencies?: Record<string, string>;
}

function readPkg(dir: string): Pkg {
  return JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')) as Pkg;
}

/** workspace package name → its dir (packages/*). */
function workspacePackages(): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of readdirSync(join(ROOT, 'packages'))) {
    const rel = join('packages', d);
    if (existsSync(join(ROOT, rel, 'package.json'))) out.set(readPkg(rel).name, rel);
  }
  return out;
}

/** The app dir plus the dirs of every workspace package it (transitively) depends on at runtime. */
function dirsFor(appDir: string, ws: Map<string, string>): string[] {
  const seen = new Set<string>([appDir]);
  const queue = [appDir];
  while (queue.length) {
    const deps = readPkg(queue.shift()!).dependencies ?? {};
    for (const [name, spec] of Object.entries(deps)) {
      const dir = ws.get(name);
      if (!spec.startsWith('workspace:') || !dir || seen.has(dir)) continue;
      seen.add(dir);
      queue.push(dir);
    }
  }
  return [...seen];
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string): void => {
    for (const name of readdirSync(abs)) {
      if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
      const p = join(abs, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (SRC_EXT.test(name) && !TEST_FILE.test(name) && !name.endsWith('.d.ts')) out.push(p);
    }
  };
  walk(join(ROOT, dir));
  return out;
}

const ENV_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/** A `|| x` or `?? x` right after the read: the code has a fallback. */
const FALLBACK = /^[^;\n]{0,30}?(\|\||\?\?)/;

function envNamesIn(src: string, withFallback: Set<string>): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    names.add(m[1]!);
    if (FALLBACK.test(src.slice(m.index + m[0].length))) withFallback.add(m[1]!);
  }
  for (const m of src.matchAll(/process\.env\[\s*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]\s*\]/g)) names.add(m[1]!);
  for (const m of src.matchAll(/\{([^{}]*)\}\s*=\s*process\.env\b/g)) {
    for (const part of m[1]!.split(',')) {
      const key = part.split(':')[0]!.split('=')[0]!.trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) names.add(key);
    }
  }
  const dynamic = /process\.env\[\s*[A-Za-z_]/.test(src) || /=\s*process\.env\s*[;,)]/.test(src);
  if (dynamic) {
    for (const m of src.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1]!);
    for (const m of src.matchAll(/['"`]([A-Z][A-Z0-9_]*)['"`]/g)) if (ENV_NAME.test(m[1]!)) names.add(m[1]!);
  }
  return names;
}

function codeEnv(dirs: string[]): { used: Set<string>; withFallback: Set<string> } {
  const used = new Set<string>();
  const withFallback = new Set<string>();
  for (const dir of dirs) {
    for (const f of sourceFiles(dir)) for (const n of envNamesIn(readFileSync(f, 'utf8'), withFallback)) used.add(n);
    for (const dep of Object.keys(readPkg(dir).dependencies ?? {})) for (const n of SDK_ENV[dep] ?? []) used.add(n);
  }
  for (const n of [...used]) if (SYSTEM.test(n)) used.delete(n);
  return { used, withFallback };
}

function vercel(args: string[], projectId?: string): string {
  return execFileSync('vercel', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, VERCEL_ORG_ID: TEAM_ID, ...(projectId ? { VERCEL_PROJECT_ID: projectId } : {}) },
  });
}

function projectIds(): Map<string, string> {
  const j = JSON.parse(vercel(['project', 'ls', '--json'])) as { projects: Array<{ name: string; id: string }> };
  return new Map(j.projects.map((p) => [p.name, p.id]));
}

/** Names only; the JSON listing carries no values and none are read. */
function vercelProdEnv(projectId: string): Set<string> {
  const j = JSON.parse(vercel(['env', 'ls', 'production', '--format', 'json'], projectId)) as {
    envs: Array<{ key: string }>;
  };
  return new Set(j.envs.map((e) => e.key));
}

function main(): void {
  const only = process.argv.slice(2);
  const ws = workspacePackages();
  const ids = projectIds();
  let drift = 0;

  for (const p of PROJECTS) {
    if (only.length && !only.includes(p.vercel)) continue;
    const id = ids.get(p.vercel);
    console.log(`\n== ${p.vercel} (${p.dir})`);
    if (!id) {
      console.log('  !! project not found in `vercel project ls`');
      drift++;
      continue;
    }
    const dirs = dirsFor(p.dir, ws);
    const { used, withFallback } = codeEnv(dirs);
    const set = vercelProdEnv(id);
    const missing = [...used].filter((n) => !set.has(n)).sort();
    const required = missing.filter((n) => !withFallback.has(n));
    const optional = missing.filter((n) => withFallback.has(n));
    const unused = [...set].filter((n) => !used.has(n) && !SYSTEM.test(n)).sort();
    console.log(`  reads ${used.size} names across ${dirs.length} dirs; Vercel production has ${set.size}`);
    console.log(`  missing in Vercel, no fallback seen (${required.length}): ${required.join(', ') || '-'}`);
    console.log(`  missing in Vercel, code has a fallback (${optional.length}): ${optional.join(', ') || '-'}`);
    console.log(`  set but unused (${unused.length}): ${unused.join(', ') || '-'}`);
    drift += required.length + unused.length;
  }
  console.log(
    '\nHeuristic: "no fallback seen" can still be optional (null-checked later); "unused" may be read by a framework or a dynamic name. Check before changing anything.',
  );
  process.exitCode = drift ? 1 : 0;
}

main();
