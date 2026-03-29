/**
 * Pipedrive CRM client — Lead/Deal CRUD and activity logging.
 *
 * TODO: Extract from aac-slim/src/clients/pipedrive.ts (507 lines)
 * during Phase 0. Refactor to accept config via constructor instead
 * of reading process.env.
 */

export interface PipedriveConfig {
  apiKey: string;
  companyDomain: string;
  systemUserId?: string;
}

export class PipedriveClient {
  constructor(private config: PipedriveConfig) {}

  // --- Person CRUD ---
  async searchPersonByPhone(_phone: string) { return this.stub('searchPersonByPhone'); }
  async searchPersonByName(_name: string) { return this.stub('searchPersonByName'); }
  async createPerson(_data: Record<string, unknown>) { return this.stub('createPerson'); }
  async updatePerson(_id: string, _data: Record<string, unknown>) { return this.stub('updatePerson'); }
  async getPerson(_id: string) { return this.stub('getPerson'); }

  // --- Deal CRUD ---
  async createDeal(_data: Record<string, unknown>) { return this.stub('createDeal'); }
  async updateDeal(_id: string, _data: Record<string, unknown>) { return this.stub('updateDeal'); }

  // --- Activity logging ---
  async logActivity(_personId: string, _type: string, _data: Record<string, unknown>) { return this.stub('logActivity'); }

  // --- Attribution ---
  async getReferralChain(_personId: string) { return this.stub('getReferralChain'); }
  async getPersonOwner(_personId: string) { return this.stub('getPersonOwner'); }

  private stub(method: string): never {
    throw new Error(`PipedriveClient.${method}() not yet extracted — run Phase 0`);
  }
}
