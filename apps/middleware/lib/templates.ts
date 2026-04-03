/**
 * Message templates for cron-driven SMS (reminders, follow-ups, alerts).
 *
 * Templates live here as code for now. Future: move to Redis so they
 * can be edited from Command Center settings without a deploy.
 */

export interface MessageTemplate {
  name: string;
  body: string;
}

const templates = {
  jobReminder: {
    name: 'Job Reminder (Day Before)',
    body: [
      'Hi {firstName}, this is a reminder from Attack A Crack',
      'that our technician will be at your home at {time} tomorrow, {date}.',
      'Please let me know if you have any questions.',
    ].join(' '),
  },

  jobFollowUp: {
    name: 'Post-Job Follow-Up',
    body: [
      'Hi {firstName}, this is Matt from Attack A Crack.',
      'I hope everything went well with your recent repair.',
      'If you have any questions, don\'t hesitate to reach out.',
      'If you\'re happy with the work, we\'d really appreciate a Google review: {reviewLink}',
      '\n\nThank you for choosing Attack A Crack!',
    ].join(' '),
  },

  estimateApprovedAlert: {
    name: 'Estimate Approved Alert (to Matt)',
    body: 'Estimate approved: {customerName} — #{estimateNumber} (${amount}). Stub event created: {calendarLink}',
  },
} as const satisfies Record<string, MessageTemplate>;

export type TemplateName = keyof typeof templates;

/**
 * Render a template with variable substitution.
 * Throws if a required variable is missing from the provided values.
 */
export function renderTemplate(
  templateName: TemplateName,
  variables: Record<string, string>
): string {
  const template = templates[templateName];
  let result = template.body;

  const missingVars: string[] = [];
  result = result.replace(/\{(\w+)\}/g, (match, varName: string) => {
    if (varName in variables) {
      return variables[varName];
    }
    missingVars.push(varName);
    return match;
  });

  if (missingVars.length > 0) {
    throw new Error(
      `Template "${templateName}" missing variables: ${missingVars.join(', ')}`
    );
  }

  return result;
}

export { templates };
