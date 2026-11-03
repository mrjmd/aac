import { createHash } from 'node:crypto';
import type { TodoItem } from '@aac/shared-utils/types';
import { daysBetween } from './dates.js';
import type { ItemCandidate, Severity } from './types.js';

export const TODO_KEY_PREFIX = 'todo:';

/**
 * Matt's own to-dos as items, so they sit on Today beside detector findings.
 * Overdue or due today = red, due within a week = yellow, else info.
 * The fingerprint is title + due date: moving the date reopens a snoozed or
 * dismissed to-do; ticking a step does not.
 */
export function fromTodo(todo: TodoItem, today: string): ItemCandidate {
  let severity: Severity = 'info';
  let when = '';
  if (todo.dueDate) {
    const days = daysBetween(today, todo.dueDate.slice(0, 10));
    severity = days <= 0 ? 'red' : days <= 7 ? 'yellow' : 'info';
    when = days < 0 ? `${-days}d overdue` : days === 0 ? 'due today' : `due in ${days}d`;
  }
  const steps = todo.steps ?? [];
  const next = steps.find((s) => !s.done);
  const candidate: ItemCandidate = {
    key: `${TODO_KEY_PREFIX}${todo.id}`,
    detector: 'TODO',
    area: 'admin',
    lane: 'needs-you',
    severity,
    title: when ? `${todo.title} (${when})` : todo.title,
    fingerprint: createHash('sha256').update(`${todo.title}|${todo.dueDate ?? ''}`).digest('hex').slice(0, 16),
  };
  if (todo.notes) candidate.detail = todo.notes;
  if (next) candidate.action = `Next: ${next.text} (${steps.filter((s) => s.done).length}/${steps.length} done)`;
  return candidate;
}
