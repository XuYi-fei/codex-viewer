import { randomToken, setCookie, sha256, cookieParse } from './utils.js';

const SESSION_TTL_SECONDS = 60 * 60 * 24;
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
const PAIR_TTL_MS = SESSION_TTL_MS;

export class AuthManager {
  constructor() {
    this.pairings = new Map();
    this.sessions = new Map();
  }

  issuePairing() {
    const token = randomToken(18);
    const pairing = {
      token,
      tokenHash: sha256(token),
      createdAt: Date.now(),
      expiresAt: Date.now() + PAIR_TTL_MS,
    };
    this.pairings.set(pairing.tokenHash, pairing);
    return pairing;
  }

  exchangePairing(token) {
    const pairing = this.pairings.get(sha256(token));
    if (!pairing || pairing.expiresAt < Date.now()) {
      return null;
    }
    pairing.expiresAt = Date.now() + PAIR_TTL_MS;

    const sessionId = randomToken(12);
    const bearerToken = randomToken(24);
    const session = {
      id: sessionId,
      bearerToken,
      bearerHash: sha256(bearerToken),
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS,
      lastSeenAt: Date.now(),
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  getPairing() {
    const active = [...this.pairings.values()].find((entry) => entry.expiresAt > Date.now());
    return active || this.issuePairing();
  }

  authenticate(req) {
    const now = Date.now();
    const cookies = cookieParse(req.headers.cookie || '');
    const sessionId = cookies.cv_session;
    const authHeader = req.headers.authorization || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!bearer) return null;

    const bearerHash = sha256(bearer);
    let session = sessionId ? this.sessions.get(sessionId) : null;
    if (session && session.expiresAt < now) {
      this.sessions.delete(session.id);
      session = null;
    }
    if (session && session.bearerHash !== bearerHash) {
      session = null;
    }
    if (!session) {
      session = [...this.sessions.values()].find((entry) => entry.bearerHash === bearerHash && entry.expiresAt >= now) || null;
    }
    if (!session) return null;

    session.lastSeenAt = now;
    session.expiresAt = now + SESSION_TTL_MS;
    return session;
  }

  cookieFor(session) {
    return setCookie('cv_session', session.id, { maxAge: SESSION_TTL_SECONDS });
  }
}
