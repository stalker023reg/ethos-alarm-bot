/// <reference lib="dom" />

import Privy, { LocalStorage } from '@privy-io/js-sdk-core';
import type { User, LinkedAccount } from '@privy-io/api-types';

const OAUTH_PROVIDER = 'twitter';
const LOGIN_TOKEN_STORAGE_KEY = 'ethos_alarm_bot:login_token';
interface AuthClientConfig {
  privyAppId: string;
  privyClientId?: string;
}

async function fetchAuthConfig(): Promise<AuthClientConfig> {
  const response = await fetch('/auth/config', {
    cache: 'no-store',
  });

  const payload = await response.json().catch(() => null) as
    | (Partial<AuthClientConfig> & { error?: string })
    | null;

  if (!response.ok) {
    throw new Error(payload?.error || 'Authentication service unavailable');
  }

  if (!payload?.privyAppId) {
    throw new Error('Authentication service unavailable');
  }

  return {
    privyAppId: payload.privyAppId,
    privyClientId: payload.privyClientId || undefined,
  };
}

async function initializePrivy(config: AuthClientConfig): Promise<Privy> {
  const privy = new Privy({
    appId: config.privyAppId,
    clientId: config.privyClientId,
    storage: new LocalStorage(),
  });

  await privy.initialize();
  return privy;
}

async function loginWithTwitter(privy: Privy, redirectUri: string): Promise<void> {
  const { url } = await privy.auth.oauth.generateURL(OAUTH_PROVIDER, redirectUri);
  window.location.assign(url);
}

function extractTwitterUsername(user: User | null | undefined): string | null {
  const twitterAccount = user?.linked_accounts.find((account: LinkedAccount) => account.type === 'twitter_oauth');
  return twitterAccount && 'username' in twitterAccount ? twitterAccount.username || null : null;
}

async function completeTwitterLogin(
  privy: Privy,
  code: string,
  state: string,
): Promise<{ accessToken: string; xUsername: string | null }> {
  const authResult = await privy.auth.oauth.loginWithCode(code, state, OAUTH_PROVIDER);
  const accessToken = await privy.getAccessToken();

  if (!accessToken) {
    throw new Error('Privy authentication failed');
  }

  return {
    accessToken,
    xUsername: extractTwitterUsername(authResult.user),
  };
}

async function getExistingAccessToken(privy: Privy): Promise<string | null> {
  const accessToken = await privy.getAccessToken();
  return accessToken || null;
}

async function getCurrentUsername(privy: Privy): Promise<string | null> {
  const { user } = await privy.user.get();
  return extractTwitterUsername(user);
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to complete login.';
}

function stripOAuthParamsFromUrl(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('code');
  url.searchParams.delete('state');
  url.searchParams.delete('privy_oauth_code');
  url.searchParams.delete('privy_oauth_state');
  url.searchParams.delete('error');
  url.searchParams.delete('error_description');
  window.history.replaceState({}, document.title, url.toString());
}

async function boot(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const loginToken = params.get('token') || window.sessionStorage.getItem(LOGIN_TOKEN_STORAGE_KEY);
  const oauthCode = params.get('code') || params.get('privy_oauth_code');
  const oauthState = params.get('state') || params.get('privy_oauth_state');
  const oauthError = params.get('error');
  const oauthErrorDescription = params.get('error_description');

  const loginButton = document.getElementById('login') as HTMLButtonElement | null;
  const buttonText = document.getElementById('buttonText');
  const statusEl = document.getElementById('status');
  const metaEl = document.getElementById('meta');
  const cardEl = document.getElementById('card');

  if (!loginButton || !buttonText || !statusEl || !metaEl || !cardEl) {
    console.error('Required DOM elements missing');
    return;
  }

  const loginButtonEl = loginButton;
  const buttonTextEl = buttonText;
  const statusElRef = statusEl;
  const metaElRef = metaEl;
  const cardElRef = cardEl;
  let loginInProgress = false;

  function setLoading(isLoading: boolean, message = 'Signing in...'): void {
    loginButtonEl.disabled = isLoading;
    buttonTextEl.textContent = isLoading ? message : 'Login with X';
    statusElRef.className = 'status';
    statusElRef.textContent = isLoading ? message : '';
  }

  function setError(message: string): void {
    statusElRef.className = 'status error';
    statusElRef.textContent = message;
  }

  function showSuccess(): void {
    loginInProgress = false;
    cardElRef.innerHTML = [
      '<div class="success">',
      '  <div class="success-badge">\u2713</div>',
      '  <h2>Telegram linked successfully</h2>',
      '  <p>You can return to Telegram.</p>',
      '</div>',
    ].join('');

    setTimeout(() => {
      window.location.assign('https://t.me/EthosAlarmBot');
    }, 2500);
  }

  async function linkTelegramAccount(privyToken: string, xUsername: string): Promise<void> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10000);

    let linkResponse: Response;

    try {
      linkResponse = await fetch('/link-telegram', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          loginToken,
          privyToken,
          xUsername,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const result = await linkResponse.json();

    if (!linkResponse.ok || !result.success) {
      throw new Error(result.error || 'Failed to link Telegram account');
    }

    window.sessionStorage.removeItem(LOGIN_TOKEN_STORAGE_KEY);
  }

  if (!loginToken) {
    setError('Invalid login link.');
    loginButtonEl.disabled = true;
    return;
  }

  let privy: Privy;

  try {
    const authConfig = await fetchAuthConfig();
    privy = await initializePrivy(authConfig);
  } catch (error) {
    console.error('Privy Core SDK failed to initialize', error);
    loginButtonEl.disabled = true;
    setError(toMessage(error));
    return;
  }

  if (oauthError) {
    console.error('Privy OAuth returned an error', {
      oauthError,
      oauthErrorDescription,
    });
    setError(oauthErrorDescription || 'Authentication failed');
    stripOAuthParamsFromUrl();
    return;
  }

  if (oauthCode && oauthState) {
    loginInProgress = true;

    try {
      console.log('Completing Privy OAuth login', {
        hasOAuthCode: Boolean(oauthCode),
        hasOAuthState: Boolean(oauthState),
      });
      setLoading(true, 'Completing login...');
      const authResult = await completeTwitterLogin(privy, oauthCode, oauthState);

      if (!authResult.xUsername) {
        throw new Error('Twitter username is missing from Privy account');
      }

      await linkTelegramAccount(authResult.accessToken, authResult.xUsername);

      stripOAuthParamsFromUrl();
      showSuccess();
      return;
    } catch (error) {
      setLoading(false);
      loginInProgress = false;
      stripOAuthParamsFromUrl();
      setError(toMessage(error));
      return;
    }
  }

  try {
    const existingAccessToken = await getExistingAccessToken(privy);

    if (existingAccessToken) {
      const xUsername = await getCurrentUsername(privy);

      if (!xUsername) {
        throw new Error('Twitter username is missing from Privy account');
      }

      console.log('Found existing Privy access token, linking Telegram account');
      loginInProgress = true;
      setLoading(true, 'Linking account...');
      await linkTelegramAccount(existingAccessToken, xUsername);
      showSuccess();
      return;
    }
  } catch (error) {
    setLoading(false);
    loginInProgress = false;
    setError(toMessage(error));
    return;
  }

  metaElRef.textContent = 'Secure login token detected. Continue with X to link your Ethos account.';

  loginButtonEl.onclick = async () => {
    if (loginInProgress) {
      return;
    }

    loginInProgress = true;

    try {
      setLoading(true);
      window.sessionStorage.setItem(LOGIN_TOKEN_STORAGE_KEY, loginToken);
      await loginWithTwitter(privy, window.location.href);
    } catch (error) {
      setLoading(false);
      loginInProgress = false;
      setError(toMessage(error));
    }
  };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  void boot();
}
