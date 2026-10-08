import { afterEach, describe, expect, it, vi } from 'vitest';

const signUp = vi.fn();
vi.mock('../../../backend/auth/supabase-client.js', () => ({
  createAuthClient: () => ({ auth: { signUp } }),
}));
const { loadConfig } = await import('../../../backend/core/config.js');
const { createApp } = await import('../../../backend/http/app.js');
const { captureLogger } = await import('../../helpers/capture-logger.js');

const ORIGIN = 'https://signup-staging.taply.test';
function app(env: 'test' | 'production' = 'test') {
  return createApp({ config: loadConfig({ APP_ENV: env, APP_ORIGIN: ORIGIN }), logger: captureLogger().logger });
}
const body = {
  businessName:'Boutique Test Taply',
  email:'newowner@example.com',
  password:'secureSecret_1234',
  termsAccepted:true,
};
function signup(value: unknown, origin = ORIGIN, env: 'test'|'production'='test') {
  return app(env).request('/api/auth/signup', {
    method:'POST', headers:{ Origin:origin,'Content-Type':'application/json' },
    body:JSON.stringify(value),
  });
}
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('POST /api/auth/signup — preview uniquement', () => {
  it('désactivé par défaut même avec données valides', async () => {
    expect((await signup(body)).status).toBe(503);
    expect(signUp).not.toHaveBeenCalled();
  });
  it('refus systématique en production même si flag actif', async () => {
    vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
    expect((await signup(body,ORIGIN,'production')).status).toBe(503);
    vi.stubEnv('VERCEL_ENV', 'production');
    expect((await signup(body)).status).toBe(503);
    expect(signUp).not.toHaveBeenCalled();
  });
  it('Origin étrangère refusée (protection CSRF)', async () => {
    vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
    expect((await signup(body,'https://evil.test')).status).toBe(403);
    expect(signUp).not.toHaveBeenCalled();
  });
  it('email, nom, consentement, mot de passe suffisamment long et champs supplémentaires vérifiés', async () => {
    vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
    for(const invalid of [
      { ...body, password:'short' },
      { ...body, termsAccepted:false },
      { ...body, businessName:'X' },
      { ...body, businessName:'X'.repeat(81) },
      { ...body, email:'invalid' },
      { ...body, role:'owner' },
    ]) {
      expect((await signup(invalid)).status).toBe(400);
    }
    expect(signUp).not.toHaveBeenCalled();
  });
  it('crée un compte Supabase Auth avec marqueur onboarding et emailRedirectTo sûr', async () => {
    vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
    signUp.mockResolvedValue({ data:{ user:{ id:'ignored' } }, error:null });
    const r=await signup(body);
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ emailSent:true });
    expect(signUp).toHaveBeenCalledWith({
      email:body.email,password:body.password,options:{
        emailRedirectTo:ORIGIN+'/connexion.html?confirmation=ok',
        data:{ taply_onboarding_v1:true,taply_business_name:body.businessName },
      },
    });
  });
  it('un échec de livraison e-mail n’annonce pas une inscription réussie', async () => {
    vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
    signUp.mockResolvedValue({ data:{user:null}, error:{status:502,message:'SMTP failure'} });
    expect((await signup(body)).status).toBe(503);
  });
  it('limitation provider 429 préservée', async () => {
    vi.stubEnv('TAPLY_LOYALTY_PREVIEW', 'enabled');
    signUp.mockResolvedValue({ data:{user:null}, error:{status:429,message:'rate limited'} });
    expect((await signup(body)).status).toBe(429);
  });
});
