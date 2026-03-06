import { randomToken, setCookie, sha256, cookieParse } from './utils.js';

const SESSION_TTL_SECONDS = 60 * 60 * 12;
const PAIR_TTL_MS = 1000 * 60 * 10;

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
      used: false,
    };
    this.pairings.set(pairing.tokenHash, pairing);
    return pairing;
  }

  exchangePairing(token) {
    const pairing = this.pairings.get(sha256(token));
    if (!pairing || pairing.used || pairing.expiresAt < Date.now()) {
      return null;
    }
    pairing.used = true;

    const sessionId = randomToken(12);
    const bearerToken = randomToken(24);
    const session = {
      id: sessionId,
      bearerToken,
      bearerHash: sha256(bearerToken),
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
      lastSeenAt: Date.now(),
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  getPairing() {
    const active = [...this.pairings.values()].find((entry) => !entry.used && entry.expiresAt > Date.now());
    return active || this.issuePairing();
  }

  authenticate(req) {
    const cookies = cookieParse(req.headers.cookie || '');
    const sessionId = cookies.cv_session;
    const authHeader = req.headers.authorization || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const session = sessionId ? this.sessions.get(sessionId) : null;
    if (!session || session.expiresAt < Date.now()) return null;
    if (!bearer || sha256(bearer) !== session.bearerHash) return null;
    session.lastSeenAt = Date.now();
    return session;
  }

  cookieFor(session) {
    return setCookie('cv_session', session.id, { maxAge: SESSION_TTL_SECONDS });
  }
}
