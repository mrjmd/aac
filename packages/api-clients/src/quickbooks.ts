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

// ── Estimate / Invoice shared types ──────────────────────────────────

export interface QBRef {
  value: string;
  name?: string;
}

export interface QBSalesItemLineDetail {
  ItemRef?: QBRef;
  Qty?: number;
  UnitPrice?: number;
  TaxCodeRef?: QBRef;
}

export interface QBLine {
  Id?: string;
  LineNum?: number;
  Description?: string;
  Amount: number;
  DetailType: string;
  SalesItemLineDetail?: QBSalesItemLineDetail;
}

export interface QBLinkedTxn {
  TxnId: string;
  TxnType: 'Estimate' | 'Invoice' | 'Payment' | 'CreditMemo';
}

export type QBEstimateStatus =
  | 'Pending'
  | 'Accepted'
  | 'Rejected'
  | 'Converted'
  | 'Closed';

export interface QBEstimate {
  Id: string;
  SyncToken: string;
  DocNumber?: string;
  TxnDate?: string;
  TxnStatus?: QBEstimateStatus;
  CustomerRef: QBRef;
  Line: QBLine[];
  TotalAmt?: number;
  BillEmail?: { Address: string };
  LinkedTxn?: QBLinkedTxn[];
  MetaData?: { CreateTime?: string; LastUpdatedTime?: string };
}

export type QBInvoiceEmailStatus = 'NotSet' | 'NeedToSend' | 'EmailSent';

export interface QBInvoice {
  Id: string;
  SyncToken: string;
  DocNumber?: string;
  TxnDate?: string;
  CustomerRef: QBRef;
  Line: QBLine[];
  TotalAmt?: number;
  Balance?: number;
  EmailStatus?: QBInvoiceEmailStatus;
  BillEmail?: { Address: string };
  LinkedTxn?: QBLinkedTxn[];
  MetaData?: { CreateTime?: string; LastUpdatedTime?: string };
}

export interface QBPaymentMethod {
  Id: string;
  Name: string;
  Type?: 'CREDIT_CARD' | 'NON_CREDIT_CARD';
  Active?: boolean;
}

export interface QBPayment {
  Id: string;
  SyncToken: string;
  TxnDate?: string;
  TotalAmt: number;
  CustomerRef: QBRef;
  PaymentMethodRef?: QBRef;
  DepositToAccountRef?: QBRef;
  /** "Reference #" the user typed at payment time — usually the check number for Check payments. */
  PaymentRefNum?: string;
  Line?: Array<{
    Amount: number;
    LinkedTxn?: QBLinkedTxn[];
  }>;
  MetaData?: { CreateTime?: string; LastUpdatedTime?: string };
}

export interface QBAccount {
  Id: string;
  Name: string;
  AccountType: string;
  AccountSubType?: string;
  CurrentBalance?: number;
  Active?: boolean;
}

export interface QBDepositLine {
  Amount: number;
  DetailType: 'DepositLineDetail';
  DepositLineDetail?: Record<string, unknown>;
  LinkedTxn?: QBLinkedTxn[];
}

export interface QBDeposit {
  Id: string;
  SyncToken: string;
  TxnDate?: string;
  TotalAmt: number;
  DepositToAccountRef: QBRef;
  Line: QBDepositLine[];
  MetaData?: { CreateTime?: string; LastUpdatedTime?: string };
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

  // ── Estimates ───────────────────────────────────────────────────

  /**
   * Fetch a single Estimate by its QB Id. Returns null on 404 (deleted /
   * unknown ID) instead of throwing — callers that store an estimate ID
   * (e.g. PD deal.qb_estimate_id) shouldn't have to special-case 404 vs.
   * "this estimate doesn't belong to this deal anymore."
   */
  async getEstimate(estimateId: string): Promise<QBEstimate | null> {
    try {
      const result = await this.request<{ Estimate: QBEstimate }>(
        `/estimate/${encodeURIComponent(estimateId)}?minorversion=70`,
      );
      return result.Estimate || null;
    } catch (error) {
      const msg = (error as Error).message;
      if (msg.includes('404') || msg.includes('not found')) {
        log.warn('Estimate not found', { estimateId });
        return null;
      }
      throw error;
    }
  }

  async getEstimatesByCustomer(
    customerId: string,
    status?: QBEstimateStatus
  ): Promise<QBEstimate[]> {
    const escapedId = customerId.replace(/'/g, "\\'");
    // QB does NOT allow filtering Estimate by TxnStatus in the query API
    // ("property 'TxnStatus' is not queryable"). Fetch all, filter client-side.
    const sql = `SELECT * FROM Estimate WHERE CustomerRef = '${escapedId}' ORDER BY MetaData.CreateTime DESC MAXRESULTS 100`;

    const result = await this.request<{ QueryResponse?: { Estimate?: QBEstimate[] } }>(
      `/query?query=${encodeURIComponent(sql)}&minorversion=70`
    );
    const estimates = result.QueryResponse?.Estimate ?? [];
    return status ? estimates.filter((e) => e.TxnStatus === status) : estimates;
  }

  /**
   * List recent estimates across all customers. Used by the deal-spine
   * reconcile cron to catch new/changed estimates that haven't been mirrored
   * into a PD deal yet.
   *
   * Filter by `TxnDate >= sinceISODate` (the user-controlled transaction date,
   * which is queryable). Status filtering is intentionally NOT done in the
   * query — QB rejects `TxnStatus` in WHERE clauses — so callers filter
   * client-side via the returned `TxnStatus` field.
   */
  async listRecentEstimates(sinceISODate?: string): Promise<QBEstimate[]> {
    let sql = 'SELECT * FROM Estimate';
    if (sinceISODate) sql += ` WHERE TxnDate >= '${sinceISODate}'`;
    sql += ' ORDER BY MetaData.CreateTime DESC MAXRESULTS 200';

    const result = await this.request<{ QueryResponse?: { Estimate?: QBEstimate[] } }>(
      `/query?query=${encodeURIComponent(sql)}&minorversion=70`,
    );
    return result.QueryResponse?.Estimate ?? [];
  }

  // ── Invoices ────────────────────────────────────────────────────

  async getInvoicesByCustomer(
    customerId: string,
    sinceISODate?: string
  ): Promise<QBInvoice[]> {
    const escapedId = customerId.replace(/'/g, "\\'");
    let sql = `SELECT * FROM Invoice WHERE CustomerRef = '${escapedId}'`;
    if (sinceISODate) sql += ` AND TxnDate >= '${sinceISODate}'`;
    sql += ' ORDER BY MetaData.CreateTime DESC MAXRESULTS 100';

    const result = await this.request<{ QueryResponse?: { Invoice?: QBInvoice[] } }>(
      `/query?query=${encodeURIComponent(sql)}&minorversion=70`
    );
    return result.QueryResponse?.Invoice ?? [];
  }

  /**
   * List recent invoices across all customers. Used by the deal-spine
   * reconcile cron to advance deals into Paid (Balance = 0) or Job Done
   * (Balance > 0) without depending on per-customer iteration.
   *
   * Callers filter by `Balance` client-side (it's queryable in QB but the
   * field semantics are clearer when the cron logic owns the rule).
   */
  async listRecentInvoices(sinceISODate?: string): Promise<QBInvoice[]> {
    let sql = 'SELECT * FROM Invoice';
    if (sinceISODate) sql += ` WHERE TxnDate >= '${sinceISODate}'`;
    sql += ' ORDER BY MetaData.CreateTime DESC MAXRESULTS 200';

    const result = await this.request<{ QueryResponse?: { Invoice?: QBInvoice[] } }>(
      `/query?query=${encodeURIComponent(sql)}&minorversion=70`,
    );
    return result.QueryResponse?.Invoice ?? [];
  }

  /**
   * Convert an Accepted estimate into an Invoice, preserving the link.
   * Copies the estimate's customer, line items, and bill-email; sets
   * LinkedTxn so QB shows the invoice as derived from the estimate.
   *
   * Does NOT send the invoice — call sendInvoice() separately.
   */
  async createInvoiceFromEstimate(estimateId: string): Promise<QBInvoice> {
    log.info('Creating invoice from estimate', { estimateId });

    const estRes = await this.request<{ Estimate?: QBEstimate }>(
      `/estimate/${encodeURIComponent(estimateId)}`
    );
    const estimate = estRes.Estimate;
    if (!estimate) {
      throw new Error(`QuickBooks estimate ${estimateId} not found`);
    }

    // Drop subtotal/group summary lines — QB recalculates them on the invoice.
    const lines = estimate.Line.filter(
      (l) => l.DetailType !== 'SubTotalLineDetail' && l.DetailType !== 'GroupLineDetail'
    );

    const body: Record<string, unknown> = {
      CustomerRef: estimate.CustomerRef,
      Line: lines,
      LinkedTxn: [{ TxnId: estimate.Id, TxnType: 'Estimate' }],
    };
    if (estimate.BillEmail) body.BillEmail = estimate.BillEmail;

    const result = await this.request<{ Invoice?: QBInvoice }>('/invoice', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!result.Invoice) {
      throw new Error('QuickBooks did not return invoice after creation');
    }

    log.info('Created invoice from estimate', {
      estimateId,
      invoiceId: result.Invoice.Id,
      amount: result.Invoice.TotalAmt,
    });

    return result.Invoice;
  }

  /**
   * Send an invoice via QB's default branded email template.
   * If `email` is omitted, uses the invoice's BillEmail on file.
   *
   * IMPORTANT: this endpoint requires Content-Type: application/octet-stream
   * with an empty body. Sending application/json (our normal default) makes
   * QBO try to parse the empty body as JSON and 500 with a NullPointerException.
   */
  async sendInvoice(invoiceId: string, email?: string): Promise<QBInvoice> {
    log.info('Sending invoice', { invoiceId, email: email ?? '(default)' });

    const qs = email ? `?sendTo=${encodeURIComponent(email)}` : '';
    const result = await this.request<{ Invoice?: QBInvoice }>(
      `/invoice/${encodeURIComponent(invoiceId)}/send${qs}`,
      {
        method: 'POST',
        body: '',
        headers: { 'Content-Type': 'application/octet-stream' },
      }
    );

    if (!result.Invoice) {
      throw new Error('QuickBooks did not return invoice after send');
    }

    log.info('Sent invoice', { invoiceId, emailStatus: result.Invoice.EmailStatus });
    return result.Invoice;
  }

  async getInvoice(invoiceId: string): Promise<QBInvoice | null> {
    try {
      const result = await this.request<{ Invoice?: QBInvoice }>(
        `/invoice/${encodeURIComponent(invoiceId)}`
      );
      return result.Invoice || null;
    } catch (error) {
      log.error('Get invoice failed', error as Error, { invoiceId });
      return null;
    }
  }

  // ── Payments ────────────────────────────────────────────────────────

  /**
   * QuickBooks PaymentMethod entity (e.g. Cash, Check, Credit Card).
   * IDs are realm-specific — must be looked up at runtime via listPaymentMethods().
   */
  async listPaymentMethods(): Promise<QBPaymentMethod[]> {
    const sql = `SELECT * FROM PaymentMethod MAXRESULTS 100`;
    const result = await this.request<{ QueryResponse?: { PaymentMethod?: QBPaymentMethod[] } }>(
      `/query?query=${encodeURIComponent(sql)}&minorversion=70`
    );
    return result.QueryResponse?.PaymentMethod ?? [];
  }

  /**
   * Create a QB Payment that fully pays a single invoice.
   *
   * The amount is the invoice's outstanding Balance (caller should pass the
   * value they intend to apply). PaymentMethodRef is required — QBO records
   * it for reporting; pick by name via listPaymentMethods().
   */
  async createPaymentForInvoice(args: {
    invoiceId: string;
    customerId: string;
    amount: number;
    paymentMethodId: string;
    /** Optional ISO date for the payment (defaults to today). */
    txnDate?: string;
  }): Promise<QBPayment> {
    log.info('Creating QuickBooks payment', {
      invoiceId: args.invoiceId,
      amount: args.amount,
      paymentMethodId: args.paymentMethodId,
    });

    const body: Record<string, unknown> = {
      TotalAmt: args.amount,
      CustomerRef: { value: args.customerId },
      PaymentMethodRef: { value: args.paymentMethodId },
      Line: [
        {
          Amount: args.amount,
          LinkedTxn: [{ TxnId: args.invoiceId, TxnType: 'Invoice' }],
        },
      ],
    };
    if (args.txnDate) body.TxnDate = args.txnDate;

    const result = await this.request<{ Payment?: QBPayment }>('/payment', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!result.Payment) {
      throw new Error('QuickBooks did not return payment after creation');
    }

    log.info('Created QuickBooks payment', {
      paymentId: result.Payment.Id,
      invoiceId: args.invoiceId,
      amount: args.amount,
    });

    return result.Payment;
  }

  // ── Accounts ────────────────────────────────────────────────────────

  /** List accounts of a given AccountType (e.g. 'Bank'). Active accounts only by default. */
  async listAccounts(opts: { type?: string; activeOnly?: boolean } = {}): Promise<QBAccount[]> {
    const where: string[] = [];
    if (opts.type) where.push(`AccountType = '${opts.type.replace(/'/g, "\\'")}'`);
    if (opts.activeOnly !== false) where.push(`Active = true`);
    const sql =
      `SELECT Id, Name, AccountType, AccountSubType, CurrentBalance, Active FROM Account` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : ``) +
      ` MAXRESULTS 100`;
    const result = await this.request<{ QueryResponse?: { Account?: QBAccount[] } }>(
      `/query?query=${encodeURIComponent(sql)}&minorversion=70`
    );
    return result.QueryResponse?.Account ?? [];
  }

  // ── Deposits ────────────────────────────────────────────────────────

  /**
   * Create a QB Deposit that pulls one or more existing Payments out of
   * Undeposited Funds and into a bank account. The total Amount of the
   * Deposit lines must equal the sum of the linked Payments' totals.
   *
   * This is the "at the bank" workflow: Mike picks 3 cash and 2 check
   * payments, app POSTs a single Deposit grouping them. After this runs,
   * the QB bank-feed reconciliation will match this Deposit to one line on
   * the bank statement.
   */
  async createDeposit(args: {
    depositToAccountId: string;
    payments: Array<{ paymentId: string; amount: number }>;
    txnDate?: string;
  }): Promise<QBDeposit> {
    if (args.payments.length === 0) {
      throw new Error('createDeposit requires at least one payment');
    }
    log.info('Creating QuickBooks deposit', {
      depositToAccountId: args.depositToAccountId,
      paymentCount: args.payments.length,
      total: args.payments.reduce((s, p) => s + p.amount, 0),
    });

    const body: Record<string, unknown> = {
      DepositToAccountRef: { value: args.depositToAccountId },
      Line: args.payments.map((p) => ({
        Amount: p.amount,
        DetailType: 'DepositLineDetail',
        DepositLineDetail: {},
        LinkedTxn: [{ TxnId: p.paymentId, TxnType: 'Payment' as const }],
      })),
    };
    if (args.txnDate) body.TxnDate = args.txnDate;

    const result = await this.request<{ Deposit?: QBDeposit }>('/deposit', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!result.Deposit) {
      throw new Error('QuickBooks did not return deposit after creation');
    }

    log.info('Created QuickBooks deposit', {
      depositId: result.Deposit.Id,
      total: result.Deposit.TotalAmt,
    });

    return result.Deposit;
  }

  /** List recent deposits — used to figure out which Payments have already been deposited. */
  async listRecentDeposits(maxResults = 200): Promise<QBDeposit[]> {
    const sql = `SELECT * FROM Deposit ORDER BY TxnDate DESC MAXRESULTS ${Math.min(Math.max(1, maxResults), 1000)}`;
    const result = await this.request<{ QueryResponse?: { Deposit?: QBDeposit[] } }>(
      `/query?query=${encodeURIComponent(sql)}&minorversion=70`
    );
    return result.QueryResponse?.Deposit ?? [];
  }

  async getPayment(paymentId: string): Promise<QBPayment | null> {
    try {
      const result = await this.request<{ Payment?: QBPayment }>(
        `/payment/${encodeURIComponent(paymentId)}`
      );
      return result.Payment || null;
    } catch (error) {
      log.error('Get payment failed', error as Error, { paymentId });
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

  // ── General read access ──────────────────────────────────────────
  // Two escape hatches so callers can pull arbitrary data without us
  // having to wrap every QBO entity and report individually.

  async query<T = unknown>(sql: string): Promise<T> {
    return this.request<T>(`/query?query=${encodeURIComponent(sql)}&minorversion=70`);
  }

  async report<T = unknown>(
    name: string,
    params: Record<string, string> = {}
  ): Promise<T> {
    const search = new URLSearchParams(params);
    search.set('minorversion', '70');
    const qs = search.toString();
    return this.request<T>(`/reports/${encodeURIComponent(name)}?${qs}`);
  }
}
