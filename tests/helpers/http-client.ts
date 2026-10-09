/**
 * Client HTTP de test avec bocal à cookies, branché directement sur l'app
 * Hono (aucun réseau). Un « navigateur » = une instance.
 */
import type { Hono } from 'hono';
import type { AppEnvBindings } from '../../backend/http/types.js';

export class TestBrowser {
  readonly cookies = new Map<string, string>();
  private readonly app: Hono<AppEnvBindings>;
  private readonly origin: string;
  private readonly ip: string;
  constructor(app: Hono<AppEnvBindings>, origin: string, ip = '203.0.113.10') {
    this.app = app;
    this.origin = origin;
    this.ip = ip;
  }

  private cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private absorb(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair?.indexOf('=') ?? -1;
      if (!pair || eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /max-age=0/i.test(a.trim()) || /expires=Thu, 01 Jan 1970/i.test(a.trim()));
      if (expired || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await this.app.request(path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(method === 'GET' ? {} : { Origin: this.origin }),
        'x-real-ip': this.ip,
        ...(this.cookies.size ? { cookie: this.cookieHeader() } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    this.absorb(response);
    const text = await response.text();
    let json: any;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
    return { status: response.status, json };
  }

  get(path: string) { return this.request('GET', path); }
  post(path: string, body: unknown = {}) { return this.request('POST', path, body); }
  patch(path: string, body: unknown) { return this.request('PATCH', path, body); }
  put(path: string, body: unknown) { return this.request('PUT', path, body); }
}
