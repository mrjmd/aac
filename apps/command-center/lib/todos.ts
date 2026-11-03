/**
 * To-do item types — defined in @aac/shared-utils so the tools/src/todos CLI
 * and triage.html share the exact shape this app reads and writes.
 */

export type {
  TodoItem,
  TodoStep,
  CreateTodoInput,
  UpdateTodoInput,
} from "@aac/shared-utils/types";
export { todoScore } from "@aac/shared-utils/types";
