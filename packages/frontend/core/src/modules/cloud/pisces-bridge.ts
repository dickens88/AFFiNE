/**
 * Pisces SSO bridge.
 *
 * AFFiNE runs embedded as an iframe inside the Pisces shell. In Pisces' local
 * JWT auth mode the credential lives in the parent window and is not readable
 * cross-origin, so the parent hands it to us via `postMessage`. We keep it in
 * memory (and `sessionStorage` to survive in-iframe reloads) and attach it as a
 * Bearer token to every backend request — see `FetchService` and the cloud
 * sync socket.
 *
 * In Pisces' tianyan W3 mode there is no token: the browser forwards the SSO
 * cookies automatically (AFFiNE is served under the same parent domain), so
 * the bridge simply stays idle and requests rely on `credentials: 'include'`.
 */

const STORAGE_KEY = 'pisces_sso_token';
// Cookie name carrying the credential to the backend. MUST match what the
// server reads in `pisces-sso.ts` (`cookies.pisces_token`): the cloud sync /
// realtime WebSocket runs in a Worker and cannot set an Authorization header,
// so it authenticates purely via this cookie.
const COOKIE_NAME = 'pisces_token';
const MESSAGE_TYPE = 'pisces-sso';
const READY_MESSAGE_TYPE = 'pisces-sso-ready';
const THEME_MESSAGE_TYPE = 'pisces-theme';
const LOCALE_MESSAGE_TYPE = 'pisces-locale';
// next-themes default storageKey
const NEXT_THEMES_STORAGE_KEY = 'theme';

// Pisces locale codes → AFFiNE / i18next language codes
const LOCALE_MAP: Record<string, string> = {
  'zh-CN': 'zh-Hans',
  'en-US': 'en',
};

let piscesToken: string | null = null;
let initialized = false;

// Listeners notified whenever the Pisces credential changes (e.g. the parent
// window posts the token after the iframe has already booted). AuthService
// subscribes to trigger a session revalidation so the UI authenticates without
// waiting for an unrelated focus/visibility event.
const tokenListeners = new Set<(token: string | null) => void>();

/**
 * Subscribe to Pisces credential changes. Returns an unsubscribe function.
 */
export function subscribePiscesToken(
  listener: (token: string | null) => void
): () => void {
  tokenListeners.add(listener);
  return () => {
    tokenListeners.delete(listener);
  };
}

function isBrowser() {
  return typeof window !== 'undefined';
}

function readInitialToken(): string | null {
  if (!isBrowser()) return null;
  try {
    const fromSession = window.sessionStorage.getItem(STORAGE_KEY);
    if (fromSession) return fromSession;
  } catch {
    // sessionStorage may be unavailable (e.g. privacy mode); ignore.
  }
  try {
    const fromUrl = new URLSearchParams(window.location.search).get(
      'pisces_token'
    );
    if (fromUrl) return fromUrl;
  } catch {
    // ignore malformed url
  }
  return null;
}

function persistToken(token: string | null) {
  const changed = piscesToken !== token;
  piscesToken = token;
  try {
    if (token) {
      window.sessionStorage.setItem(STORAGE_KEY, token);
    } else {
      window.sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // ignore storage failures
  }
  // Mirror the token into a same-origin cookie so the cloud sync WebSocket
  // handshake (which runs in a Worker and cannot set request headers) still
  // carries the credential. The backend reads `pisces_token` as a JWT.
  try {
    if (token) {
      document.cookie = `${COOKIE_NAME}=${encodeURIComponent(token)}; path=/; SameSite=Lax`;
    } else {
      document.cookie = `${COOKIE_NAME}=; path=/; Max-Age=0; SameSite=Lax`;
    }
  } catch {
    // ignore cookie failures
  }
  // Notify subscribers (e.g. AuthService) so they can revalidate the session
  // against the freshly received credential.
  if (changed) {
    tokenListeners.forEach(listener => {
      try {
        listener(token);
      } catch {
        // a faulty listener must not break credential propagation
      }
    });
  }
}

/**
 * Apply the Pisces day/night theme to AFFiNE by writing localStorage and
 * dispatching a storage event so next-themes picks it up without a page reload.
 */
function applyPiscesTheme(theme: unknown) {
  if (theme !== 'dark' && theme !== 'light') return;
  try {
    localStorage.setItem(NEXT_THEMES_STORAGE_KEY, theme);
    // next-themes listens for 'storage' events to update its state.
    // We dispatch once immediately (for dynamic switches when React is already
    // mounted) and once after a short delay (for the initial-load case where
    // next-themes' useEffect storage listener may not yet be registered).
    const dispatch = () => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: NEXT_THEMES_STORAGE_KEY,
          newValue: theme,
          oldValue: null,
          storageArea: localStorage,
        })
      );
    };
    dispatch();
    setTimeout(dispatch, 500);
  } catch {
    // Ignore storage / StorageEvent failures (e.g. privacy mode).
  }
}

/**
 * Apply the Pisces locale to AFFiNE.
 * Pisces uses 'zh-CN'/'en-US'; AFFiNE uses 'zh-Hans'/'en'.
 *
 * AFFiNE's I18n entity watches 'global-cache:i18n_lng' via StorageMemento,
 * which listens on a BroadcastChannel named 'global-cache:'. Posting to a
 * separate BroadcastChannel instance with the same name delivers the update
 * to the same-tab subscriber without needing direct access to the i18next
 * singleton across code-split chunk boundaries.
 */
function applyPiscesLocale(locale: unknown) {
  if (typeof locale !== 'string') return;
  const lang = LOCALE_MAP[locale] ?? locale;
  try {
    localStorage.setItem('global-cache:i18n_lng', JSON.stringify(lang));
    const bc = new BroadcastChannel('global-cache:');
    bc.postMessage({ key: 'i18n_lng', value: lang });
    bc.close();
  } catch {
    // ignore storage / BroadcastChannel failures
  }
}

/**
 * Whether AFFiNE is running inside a Pisces iframe (i.e. embedded).
 */
export function isPiscesEmbedded(): boolean {
  return isBrowser() && window.parent !== window;
}

export function getPiscesToken(): string | null {
  return piscesToken;
}

/**
 * Initialize the bridge: start listening for the token from the parent and
 * announce readiness so the parent can push the token without relying solely
 * on the iframe `load` event.
 */
export function setupPiscesBridge() {
  if (initialized || !isBrowser()) return;
  initialized = true;

  piscesToken = readInitialToken();

  window.addEventListener('message', event => {
    // Accept only messages from the embedding parent window.
    if (event.source !== window.parent) return;
    const data = event.data;
    if (data && data.type === MESSAGE_TYPE) {
      persistToken(
        typeof data.piscesToken === 'string' ? data.piscesToken : null
      );
    }
    if (data && data.type === THEME_MESSAGE_TYPE) {
      applyPiscesTheme(data.theme);
    }
    if (data && data.type === LOCALE_MESSAGE_TYPE) {
      applyPiscesLocale(data.locale);
    }
  });

  if (isPiscesEmbedded()) {
    // Prompt the parent to (re)send the credential.
    try {
      window.parent.postMessage({ type: READY_MESSAGE_TYPE }, '*');
    } catch {
      // cross-origin postMessage with '*' should not throw, but stay safe.
    }
  }
}

// Initialize eagerly on import so the listener is in place before the parent
// posts the token.
setupPiscesBridge();
