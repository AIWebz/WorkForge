// Google Workspace connection via Google Identity Services (OAuth 2.0 token
// model for browser apps). The user supplies their own OAuth Client ID; the
// access token is stored in the credential vault and expires after ~1 hour.
import { loadScript } from './ui.js';
import { SYSTEMS } from '../extension/core/catalog.js';

export function googleScopes() {
  const scopes = new Set(['openid', 'https://www.googleapis.com/auth/userinfo.email']);
  for (const s of Object.values(SYSTEMS)) (s.googleScopes || []).forEach((x) => scopes.add(x));
  return [...scopes];
}

export async function requestGoogleToken(clientId) {
  if (!clientId) throw new Error('Enter your Google OAuth Client ID');
  await loadScript('https://accounts.google.com/gsi/client');
  const token = await new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: googleScopes().join(' '),
      callback: (resp) => {
        if (resp.error) reject(new Error(resp.error_description || resp.error));
        else resolve({ accessToken: resp.access_token, expiresAt: Date.now() + (Number(resp.expires_in) || 3600) * 1000, scope: resp.scope });
      },
      error_callback: (err) => reject(new Error(err?.message || err?.type || 'Google sign-in was cancelled')),
    });
    client.requestAccessToken({ prompt: '' });
  });
  let email = '';
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { authorization: `Bearer ${token.accessToken}` } });
    if (r.ok) email = (await r.json()).email || '';
  } catch { /* optional */ }
  return { ...token, email };
}
