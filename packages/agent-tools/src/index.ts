/**
 * @aac/agent-tools — LLM-callable read-tool surface.
 *
 * Pure functions, deps-injected, summary-shaped. Wraps `@aac/api-clients`
 * with LLM-friendly projections and join logic.
 *
 * This package is *toolset infrastructure* — apps own role-scoping and
 * conversation runtime. The package exposes `buildOwnerToolDefinitions` as
 * a convenience for the canonical owner toolset (the seven read tools);
 * apps may compose subsets or different toolsets as their use cases grow.
 *
 * Each ToolDefinition is shaped to translate cleanly into Anthropic
 * tool-use (`name`, `description`, `input_schema`) and Gemini
 * function-calling. `invoke(args)` has deps + config already curried —
 * the LLM layer just forwards parsed arguments.
 */

import {
  getCustomerContext,
  type GetCustomerContextInput,
  type CustomerContext,
} from './get-customer-context.js';
import {
  searchCalendar,
  type SearchCalendarInput,
} from './search-calendar.js';
import { listDeals, type ListDealsInput } from './list-deals.js';
import { getDeal, type GetDealInput, type DealDetail } from './get-deal.js';
import {
  findJobsMissingInvoices,
  type FindJobsMissingInvoicesInput,
  type MissingInvoiceItem,
} from './find-jobs-missing-invoices.js';
import {
  getInvoiceSummary,
  type GetInvoiceSummaryInput,
  type InvoiceSummaryResult,
} from './get-invoice-summary.js';
import {
  searchConversation,
  type SearchConversationInput,
} from './search-conversation.js';
import type {
  CalendarEventSummary,
  DealSummary,
  QuoMessageSummary,
  ToolDeps,
} from './types.js';

export * from './types.js';
export * from './get-customer-context.js';
export * from './search-calendar.js';
export * from './list-deals.js';
export * from './get-deal.js';
export * from './find-jobs-missing-invoices.js';
export * from './get-invoice-summary.js';
export * from './search-conversation.js';

export interface ToolDefinition<TInput, TOutput> {
  name: string;
  description: string;
  /** JSON-schema-shaped input descriptor for the LLM. */
  inputSchema: Record<string, unknown>;
  invoke(args: TInput): Promise<TOutput>;
}

export interface ToolConfig {
  pdCompanyDomain: string;
}

const ISO_DATETIME = { type: 'string', description: 'ISO 8601 datetime' };
const ISO_DATE_OR_DATETIME = {
  type: 'string',
  description: 'ISO 8601 date or datetime',
};

/**
 * Build the canonical owner toolset — the seven read tools.
 *
 * Apps that want role-scoping wrap this in their own routing layer
 * (e.g. apps/agent's `buildToolRegistry(role, ...)`).
 */
export function buildOwnerToolDefinitions(
  deps: ToolDeps,
  config: ToolConfig,
): Array<ToolDefinition<unknown, unknown>> {
  const tools: Array<ToolDefinition<unknown, unknown>> = [
    {
      name: 'getCustomerContext',
      description:
        'Look up a customer by Pipedrive personId or E.164 phone and get their person record, all deals, recent Quo messages/calls, and recent calendar events tagged with their deals. Use this when you need a holistic view of a contact.',
      inputSchema: {
        type: 'object',
        properties: {
          personId: { type: 'integer', description: 'Pipedrive person ID' },
          phone: { type: 'string', description: 'E.164 phone, e.g. +16175551212' },
          recentDays: {
            type: 'integer',
            description: 'Days of lookback for messages/calls/events. Default 90.',
          },
        },
        // one of personId/phone is required, validated at runtime
      },
      invoke: (args) =>
        getCustomerContext(deps, config, args as GetCustomerContextInput) as Promise<unknown>,
    } as ToolDefinition<GetCustomerContextInput, CustomerContext>,

    {
      name: 'searchCalendar',
      description:
        'List calendar events in a date range. Optionally filter by case-insensitive location keyword and color (job/assessment/callback/any). Use this for "what jobs are scheduled next week?" or "any callbacks last month?".',
      inputSchema: {
        type: 'object',
        properties: {
          rangeStart: ISO_DATETIME,
          rangeEnd: ISO_DATETIME,
          locationKeyword: { type: 'string' },
          color: { type: 'string', enum: ['job', 'assessment', 'callback', 'any'] },
        },
        required: ['rangeStart', 'rangeEnd'],
      },
      invoke: (args) =>
        searchCalendar(deps, args as SearchCalendarInput) as Promise<unknown>,
    } as ToolDefinition<SearchCalendarInput, CalendarEventSummary[]>,

    {
      name: 'listDeals',
      description:
        'List deals matching filters: stage, personId, creation-date range. Returns deal summaries; chain into getDeal for full detail on one record.',
      inputSchema: {
        type: 'object',
        properties: {
          stage: { type: 'string' },
          personId: { type: 'integer' },
          rangeStart: ISO_DATE_OR_DATETIME,
          rangeEnd: ISO_DATE_OR_DATETIME,
          limit: { type: 'integer', description: 'Default 50.' },
        },
      },
      invoke: (args) => listDeals(deps, args as ListDealsInput) as Promise<unknown>,
    } as ToolDefinition<ListDealsInput, DealSummary[]>,

    {
      name: 'getDeal',
      description:
        'Fetch one deal and its linked entities: person, QB estimate, QB invoice, and calendar events tagged with this deal\'s [deal:N] marker. Returns nulls in place of missing records.',
      inputSchema: {
        type: 'object',
        properties: {
          dealId: { type: 'integer' },
          eventLookbackDays: { type: 'integer', description: 'Default 365.' },
          eventLookForwardDays: { type: 'integer', description: 'Default 365.' },
        },
        required: ['dealId'],
      },
      invoke: (args) =>
        getDeal(deps, config, args as GetDealInput) as Promise<unknown>,
    } as ToolDefinition<GetDealInput, DealDetail>,

    {
      name: 'findJobsMissingInvoices',
      description:
        'Find green (job color) calendar events in a date range that lack a QB invoice. Each result names the reason: no_deal_link / deal_has_no_invoice / invoice_not_found_in_qb. Use this for "any jobs this week without invoices?".',
      inputSchema: {
        type: 'object',
        properties: {
          rangeStart: ISO_DATETIME,
          rangeEnd: ISO_DATETIME,
        },
        required: ['rangeStart', 'rangeEnd'],
      },
      invoke: (args) =>
        findJobsMissingInvoices(
          deps,
          config,
          args as FindJobsMissingInvoicesInput,
        ) as Promise<unknown>,
    } as ToolDefinition<FindJobsMissingInvoicesInput, MissingInvoiceItem[]>,

    {
      name: 'getInvoiceSummary',
      description:
        'Aggregate QB invoices in a date range: total count + amount, paid vs unpaid, per-customer breakdown. Defaults to the current calendar month when no range is given.',
      inputSchema: {
        type: 'object',
        properties: {
          rangeStart: ISO_DATE_OR_DATETIME,
          rangeEnd: ISO_DATE_OR_DATETIME,
        },
      },
      invoke: (args) =>
        getInvoiceSummary(deps, args as GetInvoiceSummaryInput) as Promise<unknown>,
    } as ToolDefinition<GetInvoiceSummaryInput, InvoiceSummaryResult>,

    {
      name: 'searchConversation',
      description:
        'Search Quo SMS history with a specific contact (by Pipedrive personId or E.164 phone), optionally narrowed by a case-insensitive substring query. Returns matching messages most-recent first.',
      inputSchema: {
        type: 'object',
        properties: {
          personId: { type: 'integer' },
          phone: { type: 'string' },
          query: { type: 'string' },
          limit: { type: 'integer', description: 'Default 50.' },
        },
      },
      invoke: (args) =>
        searchConversation(deps, args as SearchConversationInput) as Promise<unknown>,
    } as ToolDefinition<SearchConversationInput, QuoMessageSummary[]>,
  ];

  return tools;
}
