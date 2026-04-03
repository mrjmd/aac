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
      'that our technician Mike will be at your home at {time} tomorrow, {date}.',
      'Please let me know if you have any questions.',
    ].join(' '),
  },

  jobFollowUp: {
    name: 'Post-Job Follow-Up',
    body: [
      'Hi {firstName}, this is Matt from Attack A Crack.',
      'Just checking in to make sure everything went well with the repair.',
      'I hope Mike took great care of you!',
      '\n\nIf we did do a good job for you, I would very much appreciate a Google review.',
      'We are a small family-run business, and each review is extremely impactful.',
      'Here is the link where you can leave one.',
      'Thank you so much again for your business!',
      '\n\n{reviewLink}',
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
