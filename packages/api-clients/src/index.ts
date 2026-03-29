/**
 * @aac/api-clients — Shared API clients for all AAC systems.
 *
 * All clients are STATEFUL: they accept configuration via constructors.
 * They MUST NOT read process.env directly.
 *
 * Usage:
 *   import { PipedriveClient } from '@aac/api-clients/pipedrive';
 *   const pd = new PipedriveClient({ apiKey: '...', companyDomain: '...' });
 */

export { PipedriveClient } from './pipedrive.js';
export type { PipedriveConfig } from './pipedrive.js';

export { QuoClient } from './quo.js';
export type { QuoConfig } from './quo.js';

export { QuickBooksClient } from './quickbooks.js';
export type { QuickBooksConfig } from './quickbooks.js';

export { SearchBugClient } from './searchbug.js';
export type { SearchBugConfig } from './searchbug.js';

export { GeminiClient } from './gemini.js';
export type { GeminiConfig } from './gemini.js';

export { GoogleCalendarClient } from './google-calendar.js';
export type { GoogleCalendarConfig } from './google-calendar.js';

export { GoogleAdsClient } from './google-ads.js';
export type { GoogleAdsConfig } from './google-ads.js';

export { GoogleAnalyticsClient } from './google-analytics.js';
export type { GoogleAnalyticsConfig } from './google-analytics.js';

export { GoogleSearchConsoleClient } from './google-search-console.js';
export type { GoogleSearchConsoleConfig } from './google-search-console.js';
