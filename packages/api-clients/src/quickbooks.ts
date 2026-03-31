/**
 * QuickBooks Online client — Customer CRUD with OAuth token management.
 *
 * Extracted from aac-slim/src/clients/quickbooks.ts.
 * Refactored to class pattern. OAuth token persistence is abstracted via
 * getTokens/saveTokens callbacks — the client doesn't know about Redis.
 *
 * Stripped: getPaidInvoices, getInvoice (attribution engine only).
 */

import { createLogger } from '@aac/shared-utils/logger';
import type { QBOAuthTokens } from '@aac/shared-utils/types';

const log = createLogger('quickbooks');

const QBO_API_BASE = 'https://quickbooks.api.intuit.com/v3/company';

// ── Interfaces ───────────────────────────────────────────────────────

export interface QuickBooksConfig {
  clientId: string;
  clientSecret: string;
  realmId: string;
  redirectUri: string;
  getTokens: () => Promise<QBOAuthTokens | null>;
  saveTokens: (tokens: QBOAuthTokens) => Promise<void>;
}

export interface QBCustomer {
  Id?: string;
  DisplayName: string;
  GivenName?: string;
  FamilyName?: string;
  CompanyName?: string;
  PrimaryPhone?: {
    FreeFormNumber: string;
  };
  PrimaryEmailAddr?: {
    Address: string;
  };
  BillAddr?: {
    Line1?: string;
    City?: string;
    CountrySubDivisionCode?: string;
    PostalCode?: string;
  };
  Active?: boolean;
  SyncToken?: string;
}

interface QBResponse<T> {
  QueryResponse?: {
    Customer?: T[];
    maxResults?: number;
  };
  Customer?: T;
}

// ── Client ───────────────────────────────────────────────────────────

export class QuickBooksClient {
  constructor(private config: QuickBooksConfig) {}

  // ── OAuth token management ──────────────────────────────────────

  private async refreshAccessToken(tokens: QBOAuthTokens): Promise<QBOAuthTokens> {
    log.info('Refreshing QuickBooks access token');

    const credentials = Buffer.from(
      `${this.config.clientId}:${this.config.clientSecret}`
    ).toString('base64');

    const response = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      log.error('Token refresh failed', new Error(error), { status: response.status });
      throw new Error(`QuickBooks token refresh failed: ${response.status}`);
    }

    const data = await response.json();

    const now = Date.now();
    const newTokens: QBOAuthTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: now + data.expires_in * 1000,
      realmId: this.config.realmId,
    };

    await this.config.saveTokens(newTokens);
    log.info('QuickBooks tokens refreshed and stored');

    return newTokens;
  }

  private async getValidAccessToken(): Promise<string> {
    const tokens = await this.config.getTokens();

    if (!tokens) {
      throw new Error('QuickBooks not connected. Visit /api/auth/quickbooks/connect to authorize.');
    }

    // Check if access token is expired (with 5 minute buffer)
    const now = Date.now();
    const bufferMs = 5 * 60 * 1000;

    if (tokens.expiresAt - bufferMs < now) {
      const newTokens = await this.refreshAccessToken(tokens);
      return newTokens.accessToken;
    }

    return tokens.accessToken;
  }

  // ── Private request helper ──────────────────────────────────────

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const accessToken = await this.getValidAccessToken();

    const url = `${QBO_API_BASE}/${this.config.realmId}${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      log.error('QuickBooks API error', new Error(error), {
        endpoint,
        status: response.status,
      });
      throw new Error(`QuickBooks API error: ${response.status} - ${error}`);
    }

    return response.json();
  }

  // ── Customer CRUD ───────────────────────────────────────────────

  async searchCustomerByEmail(email: string): Promise<QBCustomer | null> {
    try {
      const escapedEmail = email.replace(/'/g, "\\'");
      const query = `SELECT * FROM Customer WHERE PrimaryEmailAddr = '${escapedEmail}'`;

      const result = await this.request<QBResponse<QBCustomer>>(
        `/query?query=${encodeURIComponent(query)}`
      );

      if (result.QueryResponse?.Customer && result.QueryResponse.Customer.length > 0) {
        log.debug('Found customer by email', { email, customerId: result.QueryResponse.Customer[0].Id });
        return result.QueryResponse.Customer[0];
      }

      return null;
    } catch (error) {
      log.error('Search customer by email failed', error as Error, { email });
      throw error;
    }
  }

  async searchCustomerByPhone(phone: string): Promise<QBCustomer | null> {
    try {
      const query = `SELECT * FROM Customer WHERE PrimaryPhone = '${phone}'`;

      const result = await this.request<QBResponse<QBCustomer>>(
        `/query?query=${encodeURIComponent(query)}`
      );

      if (result.QueryResponse?.Customer && result.QueryResponse.Customer.length > 0) {
        log.debug('Found customer by phone', { phone, customerId: result.QueryResponse.Customer[0].Id });
        return result.QueryResponse.Customer[0];
      }

      return null;
    } catch (error) {
      log.error('Search customer by phone failed', error as Error, { phone });
      throw error;
    }
  }

  async searchCustomerByName(displayName: string): Promise<QBCustomer | null> {
    try {
      const escapedName = displayName.replace(/'/g, "\\'");
      const query = `SELECT * FROM Customer WHERE DisplayName = '${escapedName}'`;

      const result = await this.request<QBResponse<QBCustomer>>(
        `/query?query=${encodeURIComponent(query)}`
      );

      if (result.QueryResponse?.Customer && result.QueryResponse.Customer.length > 0) {
        log.debug('Found customer by name', { displayName, customerId: result.QueryResponse.Customer[0].Id });
        return result.QueryResponse.Customer[0];
      }

      return null;
    } catch (error) {
      log.error('Search customer by name failed', error as Error, { displayName });
      throw error;
    }
  }

  async createCustomer(customer: {
    displayName: string;
    firstName?: string;
    lastName?: string;
    companyName?: string;
    email?: string;
    phone?: string;
  }): Promise<QBCustomer> {
    log.info('Creating QuickBooks customer', { displayName: customer.displayName });

    const body: QBCustomer = {
      DisplayName: customer.displayName,
    };

    if (customer.firstName) body.GivenName = customer.firstName;
    if (customer.lastName) body.FamilyName = customer.lastName;
    if (customer.companyName) body.CompanyName = customer.companyName;

    if (customer.email) {
      body.PrimaryEmailAddr = { Address: customer.email };
    }

    if (customer.phone) {
      body.PrimaryPhone = { FreeFormNumber: customer.phone };
    }

    const result = await this.request<QBResponse<QBCustomer>>('/customer', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!result.Customer) {
      throw new Error('QuickBooks did not return customer after creation');
    }

    log.info('Created QuickBooks customer', {
      customerId: result.Customer.Id,
      displayName: customer.displayName,
    });

    return result.Customer;
  }

  async updateCustomer(
    customerId: string,
    updates: Partial<QBCustomer> & { SyncToken: string }
  ): Promise<QBCustomer> {
    log.info('Updating QuickBooks customer', { customerId });

    const body = {
      Id: customerId,
      ...updates,
    };

    const result = await this.request<QBResponse<QBCustomer>>('/customer', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!result.Customer) {
      throw new Error('QuickBooks did not return customer after update');
    }

    log.info('Updated QuickBooks customer', { customerId });

    return result.Customer;
  }

  async getCustomer(customerId: string): Promise<QBCustomer | null> {
    try {
      const result = await this.request<QBResponse<QBCustomer>>(`/customer/${customerId}`);
      return result.Customer || null;
    } catch (error) {
      log.error('Get customer failed', error as Error, { customerId });
      return null;
    }
  }

  async isConnected(): Promise<boolean> {
    try {
      await this.getValidAccessToken();
      return true;
    } catch {
      return false;
    }
  }
}
