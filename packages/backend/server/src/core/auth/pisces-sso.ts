import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';

import { Cache, Config, defineModuleConfig } from '../../base';
import { Models } from '../../models';
import { sessionUser } from './service';
import type { Session } from './session';

export interface PiscesConfig {
  /**
   * Whether authentication is delegated to a Pisces SSO deployment.
   * Defaults to enabled whenever a validate url is configured.
   */
  enabled: boolean;
  /**
   * The Pisces introspection endpoint. Receives the original request
   * credentials (Authorization header and/or W3 cookies) and returns the
   * current username. Defaults to Pisces' `GET /login/rest/token`.
   */
  validateUrl: string;
  /**
   * Lifetime in seconds of the synthetic session produced for a validated
   * Pisces identity.
   */
  sessionTtl: number;
  /**
   * Lifetime in seconds of the cached credential -> username resolution,
   * mirroring Pisces' own 4h credential cache to avoid validating on every
   * request.
   */
  cacheTtl: number;
}

declare global {
  interface AppConfigSchema {
    pisces: PiscesConfig;
  }
}

defineModuleConfig('pisces', {
  enabled: {
    desc: 'Whether to delegate authentication to a Pisces SSO deployment.',
    default: !!process.env.PISCES_VALIDATE_URL,
  },
  validateUrl: {
    desc: 'Pisces SSO introspection endpoint used to validate the incoming credential and resolve the current username.',
    default: process.env.PISCES_VALIDATE_URL ?? '',
  },
  sessionTtl: {
    desc: 'Lifetime in seconds of the synthetic session derived from a Pisces identity.',
    default: 60 * 60 * 24 * 15, // 15 days
  },
  cacheTtl: {
    desc: 'Lifetime in seconds of the cached Pisces credential validation result.',
    default: 60 * 60 * 4, // 4 hours, matching Pisces
  },
});

const CACHE_PREFIX = 'pisces:sso:cred';
const W3_COOKIE_NAMES = ['hwsso_login', 'hwssot', 'hwssotinter3', 'login_uid'];

/**
 * Delegates request authentication to a Pisces SSO deployment.
 *
 * Both Pisces auth modes are supported transparently because Pisces' own
 * introspection endpoint already handles them:
 * - local JWT mode: the `Authorization: Bearer <jwt>` header is forwarded;
 * - tianyan W3 mode: the `hwsso_login`/`hwssot`/... cookies are forwarded.
 *
 * On success a synthetic {@link Session} is produced for a locally provisioned
 * user, so all downstream AFFiNE code that relies on `req.session.user` keeps
 * working unchanged.
 */
@Injectable()
export class PiscesSsoService {
  private readonly logger = new Logger(PiscesSsoService.name);

  constructor(
    private readonly config: Config,
    private readonly cache: Cache,
    private readonly models: Models
  ) {}

  get enabled() {
    return this.config.pisces.enabled && !!this.config.pisces.validateUrl;
  }

  async resolveSession(req: Request): Promise<Session | null> {
    if (!this.enabled) {
      return null;
    }

    const credential = this.extractCredential(req);
    if (!credential) {
      return null;
    }

    const username = await this.validate(credential);
    if (!username) {
      return null;
    }

    const user = await this.models.user.getOrCreateUserFromPisces({ username });
    if (!user || user.disabled) {
      return null;
    }

    return this.buildSession(user.id, user);
  }

  /**
   * Build the credential material to forward and to cache against. Returns
   * `null` when no Pisces credential is present on the request.
   */
  private extractCredential(req: Request): {
    authorization?: string;
    cookie?: string;
    cacheKey: string;
  } | null {
    const cookies = this.parseCookies(req);

    // local JWT mode: a Bearer header, or the `pisces_token` cookie set by the
    // embedded frontend so same-origin WebSocket handshakes (which cannot add
    // headers) still carry the credential.
    let authorization = req.headers.authorization;
    if (!authorization && cookies.pisces_token) {
      authorization = `Bearer ${cookies.pisces_token}`;
    }
    const hasJwt = !!authorization && /^Bearer\s+\S+/i.test(authorization);

    // tianyan W3 mode: SSO cookies are forwarded as-is.
    const hasW3 = !!cookies.hwsso_login;

    if (!hasJwt && !hasW3) {
      return null;
    }

    // Only the credential-bearing material participates in the cache key so
    // unrelated cookies do not fragment the cache.
    const material = hasJwt
      ? `jwt:${authorization}`
      : `w3:${W3_COOKIE_NAMES.map(n => `${n}=${cookies[n] ?? ''}`).join('&')}`;

    return {
      authorization: hasJwt ? authorization : undefined,
      cookie: hasW3 ? req.headers.cookie : undefined,
      cacheKey: `${CACHE_PREFIX}:${createHash('md5').update(material).digest('hex')}`,
    };
  }

  private parseCookies(req: Request): Record<string, string> {
    const raw = req.headers.cookie;
    const out: Record<string, string> = {};
    if (!raw) return out;
    const wanted = new Set([...W3_COOKIE_NAMES, 'pisces_token']);
    for (const pair of raw.split(';')) {
      const idx = pair.indexOf('=');
      if (idx === -1) continue;
      const name = pair.slice(0, idx).trim();
      if (wanted.has(name)) {
        out[name] = decodeURIComponent(pair.slice(idx + 1).trim());
      }
    }
    return out;
  }

  private async validate(credential: {
    authorization?: string;
    cookie?: string;
    cacheKey: string;
  }): Promise<string | null> {
    const cached = await this.cache.get<string>(credential.cacheKey);
    if (cached) {
      return cached;
    }

    const username = await this.introspect(credential);
    if (username) {
      await this.cache.set(credential.cacheKey, username, {
        ttl: this.config.pisces.cacheTtl * 1000,
      });
    }
    return username;
  }

  private async introspect(credential: {
    authorization?: string;
    cookie?: string;
  }): Promise<string | null> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (credential.authorization) {
      headers.Authorization = credential.authorization;
    }
    if (credential.cookie) {
      headers.Cookie = credential.cookie;
    }

    try {
      const resp = await fetch(this.config.pisces.validateUrl, {
        method: 'GET',
        headers,
      });
      if (!resp.ok) {
        return null;
      }
      const body = (await resp.json()) as {
        data?: { cn?: string; username?: string };
        cn?: string;
      };
      const username =
        body?.data?.cn ?? body?.data?.username ?? body?.cn ?? null;
      return username ? String(username) : null;
    } catch (e) {
      this.logger.error(`Failed to validate credential against Pisces: ${e}`);
      return null;
    }
  }

  private buildSession(
    userId: string,
    user: Parameters<typeof sessionUser>[0]
  ): Session {
    const now = Date.now();
    // Synthetic, stateless session: no row is persisted. Downstream code only
    // reads `user` and a handful of `UserSession` fields, all populated here.
    return {
      id: `pisces:${userId}`,
      sessionId: `pisces:${userId}`,
      userId,
      expiresAt: new Date(now + this.config.pisces.sessionTtl * 1000),
      signInClientVersion: null,
      refreshClientVersion: null,
      createdAt: new Date(now),
      user: sessionUser(user),
    };
  }
}
