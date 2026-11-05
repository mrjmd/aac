#!/usr/bin/env npx tsx
/**
 * Manual to-dos — the stopgap capture path until the command center's Today
 * page ships (docs/plans/command-center/round-3-todos-cards-ed.md §1).
 *
 * Reads and writes the same Redis store as apps/command-center /api/todos,
 * then refreshes the todos in analysis/data/triage/snapshot.json and
 * re-renders analysis/triage.html so the "Your list" section is current
 * without waiting for the 08:15 refresh.
 *
 *   npx tsx tools/src/todos/cli.ts add "Title" [--due 2026-11-10] [--notes "..."] [--step "..."]...
 *   npx tsx tools/src/todos/cli.ts list [--all]
 *   npx tsx tools/src/todos/cli.ts done <id-prefix> [stepNumber]
 *   npx tsx tools/src/todos/cli.ts undo <id-prefix> [stepNumber]
 *   npx tsx tools/src/todos/cli.ts edit <id-prefix> [--title ..] [--due ..|none] [--notes ..] [--step ..]...
 *   npx tsx tools/src/todos/cli.ts rm <id-prefix>
 *
 * --step on edit appends steps. Step numbers are 1-based, as `list` shows them.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Redis } from '@upstash/redis';
import { keys } from '@aac/shared-utils/redis';
import { todoScore, type TodoItem } from '@aac/shared-utils/types';
import { loadEnv, redisFromEnv } from '../lib/env';

interface Flags {
  positional: string[];
  title?: string;
  due?: string;
  notes?: string;
  steps: string[];
  all: boolean;
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { positional: [], steps: [], all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--title') flags.title = next();
    else if (a === '--due') flags.due = next();
    else if (a === '--notes') flags.notes = next();
    else if (a === '--step') flags.steps.push(next());
    else if (a === '--all') flags.all = true;
    else flags.positional.push(a);
  }
  if (flags.due && flags.due !== 'none' && !/^\d{4}-\d{2}-\d{2}$/.test(flags.due)) {
    throw new Error(`--due must be YYYY-MM-DD (or "none"), got ${flags.due}`);
  }
  return flags;
}

async function loadAll(redis: Redis): Promise<TodoItem[]> {
  const ids = await redis.zrange<string[]>(keys.todoList, 0, -1);
  if (ids.length === 0) return [];
  const pipeline = redis.pipeline();
  for (const id of ids) pipeline.get(keys.todo(id));
  const rows = await pipeline.exec<(TodoItem | null)[]>();
  return rows.filter((r): r is TodoItem => r !== null);
}

function findOne(items: TodoItem[], prefix: string | undefined): TodoItem {
  if (!prefix) throw new Error('Give the id (or its first few characters) from `list`');
  const hits = items.filter((t) => t.id.startsWith(prefix));
  if (hits.length !== 1) throw new Error(`${hits.length} to-dos match "${prefix}"`);
  return hits[0]!;
}

async function save(redis: Redis, item: TodoItem): Promise<void> {
  await Promise.all([
    redis.set(keys.todo(item.id), item),
    redis.zadd(keys.todoList, { score: todoScore(item.dueDate), member: item.id }),
  ]);
}

function stepIndex(item: TodoItem, n: string): number {
  const idx = Number(n) - 1;
  if (!item.steps || !Number.isInteger(idx) || idx < 0 || idx >= item.steps.length) {
    throw new Error(`"${item.title}" has no step ${n}`);
  }
  return idx;
}

function printList(items: TodoItem[], all: boolean): void {
  const shown = all ? items : items.filter((t) => t.status === 'pending');
  if (shown.length === 0) {
    console.log('No to-dos.');
    return;
  }
  for (const t of shown) {
    const box = t.status === 'completed' ? '[x]' : '[ ]';
    console.log(`${box} ${t.id.slice(0, 8)}  ${t.dueDate ?? '(no date)'}  ${t.title}`);
    t.steps?.forEach((s, i) => console.log(`      ${s.done ? '[x]' : '[ ]'} ${i + 1}. ${s.text}`));
  }
}

/** Mirror Redis into the triage snapshot and re-render triage.html. */
function refreshTriage(items: TodoItem[]): void {
  const snapPath = path.resolve(process.cwd(), 'analysis/data/triage/snapshot.json');
  if (!fs.existsSync(snapPath)) return;
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8')) as Record<string, unknown>;
  snap.todos = items;
  fs.writeFileSync(snapPath, JSON.stringify(snap, null, 2));
  execFileSync('npx', ['tsx', 'tools/src/triage/render.ts'], { stdio: 'inherit' });
}

async function main(): Promise<void> {
  loadEnv();
  const redis = redisFromEnv();
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseArgs(rest);
  let items = await loadAll(redis);

  switch (cmd) {
    case 'add': {
      const title = flags.positional.join(' ').trim();
      if (!title) throw new Error('add needs a title');
      const item: TodoItem = {
        id: randomUUID(),
        title,
        dueDate: flags.due && flags.due !== 'none' ? flags.due : null,
        notes: flags.notes?.trim() ?? '',
        status: 'pending',
        source: 'manual',
        createdAt: new Date().toISOString(),
        completedAt: null,
        ...(flags.steps.length ? { steps: flags.steps.map((text) => ({ text, done: false })) } : {}),
      };
      await save(redis, item);
      console.log(`Added ${item.id.slice(0, 8)}  ${item.title}`);
      break;
    }
    case 'list':
      printList(items, flags.all);
      return;
    case 'done':
    case 'undo': {
      const item = findOne(items, flags.positional[0]);
      const stepArg = flags.positional[1];
      if (stepArg) {
        item.steps![stepIndex(item, stepArg)]!.done = cmd === 'done';
      } else {
        item.status = cmd === 'done' ? 'completed' : 'pending';
        item.completedAt = cmd === 'done' ? new Date().toISOString() : null;
      }
      await save(redis, item);
      console.log(`${cmd === 'done' ? 'Done' : 'Reopened'}: ${item.title}${stepArg ? ` (step ${stepArg})` : ''}`);
      break;
    }
    case 'edit': {
      const item = findOne(items, flags.positional[0]);
      if (flags.title) item.title = flags.title.trim();
      if (flags.due) item.dueDate = flags.due === 'none' ? null : flags.due;
      if (flags.notes !== undefined) item.notes = flags.notes.trim();
      if (flags.steps.length) {
        item.steps = [...(item.steps ?? []), ...flags.steps.map((text) => ({ text, done: false }))];
      }
      await save(redis, item);
      console.log(`Updated: ${item.title}`);
      break;
    }
    case 'rm': {
      const item = findOne(items, flags.positional[0]);
      await Promise.all([redis.del(keys.todo(item.id)), redis.zrem(keys.todoList, item.id)]);
      console.log(`Deleted: ${item.title}`);
      break;
    }
    default:
      throw new Error('Usage: cli.ts add|list|done|undo|edit|rm (see header comment)');
  }

  items = await loadAll(redis);
  refreshTriage(items);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
