import { describe, it, expect } from 'vitest';
import { renderTemplate, templates } from '../lib/templates.js';

describe('templates', () => {
  describe('renderTemplate', () => {
    it('renders jobReminder with all variables', () => {
      const result = renderTemplate('jobReminder', {
        firstName: 'John',
        time: '8:00 AM',
        date: 'Friday, April 4',
      });

      expect(result).toContain('Hi John');
      expect(result).toContain('8:00 AM');
      expect(result).toContain('Friday, April 4');
      expect(result).toContain('Attack A Crack');
      expect(result).toContain('Reply STOP');
    });

    it('renders jobFollowUp with all variables', () => {
      const result = renderTemplate('jobFollowUp', {
        firstName: 'Jane',
        reviewLink: 'https://g.page/r/test/review',
      });

      expect(result).toContain('Hi Jane');
      expect(result).toContain('https://g.page/r/test/review');
      expect(result).toContain('Attack A Crack');
    });

    it('throws when a variable is missing', () => {
      expect(() =>
        renderTemplate('jobReminder', { firstName: 'John' })
      ).toThrow('missing variables: time, date');
    });

    it('throws with specific missing variable names', () => {
      expect(() =>
        renderTemplate('jobFollowUp', { firstName: 'Jane' })
      ).toThrow('missing variables: reviewLink');
    });
  });

  describe('template definitions', () => {
    it('has all expected templates', () => {
      expect(templates.jobReminder).toBeDefined();
      expect(templates.jobFollowUp).toBeDefined();
      expect(templates.estimateApprovedAlert).toBeDefined();
    });

    it('jobReminder references expected variables', () => {
      expect(templates.jobReminder.body).toContain('{firstName}');
      expect(templates.jobReminder.body).toContain('{time}');
      expect(templates.jobReminder.body).toContain('{date}');
    });

    it('jobFollowUp references expected variables', () => {
      expect(templates.jobFollowUp.body).toContain('{firstName}');
      expect(templates.jobFollowUp.body).toContain('{reviewLink}');
    });
  });
});
