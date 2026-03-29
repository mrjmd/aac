/**
 * Quo (OpenPhone) client — SMS sending and contact management.
 *
 * TODO: Extract from aac-slim/src/clients/quo.ts (320 lines)
 * during Phase 0.
 */

export interface QuoConfig {
  apiKey: string;
  phoneNumber: string;
  webhookSecret?: string;
}

export class QuoClient {
  constructor(private config: QuoConfig) {}

  async createContact(_data: Record<string, unknown>) { return this.stub('createContact'); }
  async updateContact(_id: string, _data: Record<string, unknown>) { return this.stub('updateContact'); }
  async sendSMS(_to: string, _body: string) { return this.stub('sendSMS'); }
  async createNote(_contactId: string, _content: string) { return this.stub('createNote'); }
  async getConversationHistory(_phoneNumber: string) { return this.stub('getConversationHistory'); }

  private stub(method: string): never {
    throw new Error(`QuoClient.${method}() not yet extracted — run Phase 0`);
  }
}
