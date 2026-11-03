/**
 * Google sign-in (OAuth 2.0 authorization-code flow) for the owner-facing apps.
 *
 * Covers the three calls a "Sign in with Google" button needs: build the
 * consent URL, exchange the returned code for tokens, and read the signed-in
 * user's profile. Session storage and the email allowlist stay in the app.
 *
 * Reuses the monorepo's GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. Each app
 * registers its own redirect URI (`${origin}/auth/google/callback`).
 *
 * Docs: https://developers.google.com/identity/protocols/oauth2/web-server
 */

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

/** Identity-only scopes. Apps that need API access pass extra scopes. */
export const GOOGLE_IDENTITY_SCOPES = ['openid', 'email', 'profile'] as const;

export interface GoogleSignInConfig {
  clientId: string;
  clientSecret: string;
}

export interface AuthorizeUrlOptions {
  redirectUri: string;
  /** CSRF nonce; the caller stores it and checks it on the callback. */
  state: string;
  /** Defaults to {@link GOOGLE_IDENTITY_SCOPES}. */
  scopes?: readonly string[];
  /**
   * Ask for a refresh token (access_type=offline + prompt=consent). Only
   * needed when the app calls Google APIs on the user's behalf later.
   */
  offline?: boolean;
}

export interface GoogleTokens {
  accessToken: string;
  /** Google only returns refresh_token on the first consent (or with prompt=consent). */
  refreshToken?: string;
  expiresAt: number;
  scope: string;
  idToken?: string;
}

export interface GoogleUserInfo {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
  picture?: string;
}

export class GoogleSignInClient {
  constructor(private config: GoogleSignInConfig) {}

  authorizeUrl(options: AuthorizeUrlOptions): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: options.redirectUri,
      response_type: 'code',
      scope: (options.scopes ?? GOOGLE_IDENTITY_SCOPES).join(' '),
      include_granted_scopes: 'true',
      state: options.state,
    });
    if (options.offline) {
      params.set('access_type', 'offline');
      params.set('prompt', 'consent');
    } else {
      params.set('prompt', 'select_account');
    }
    return `${GOOGLE_AUTH_URL}?${params.toString()}`;
  }

  /** Exchange the authorization code from the callback for tokens. */
  async exchangeCode(code: string, redirectUri: string): Promise<GoogleTokens> {
    const body = new URLSearchParams({
      code,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope: string;
      id_token?: string;
    };
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      scope: data.scope,
      idToken: data.id_token,
    };
  }

  /** Profile (email, name, picture) for the signed-in user. */
  async fetchUserInfo(accessToken: string): Promise<GoogleUserInfo> {
    const res = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Google userinfo failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as GoogleUserInfo;
  }
}
