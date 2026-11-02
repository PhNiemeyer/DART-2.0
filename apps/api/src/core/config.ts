/** API-Konfiguration. Produktionsstart mit Demo-Geheimnissen oder Testadaptern wird verweigert. */
export interface ApiConfig {
  env: string;
  port: number;
  appDatabaseUrl: string;
  migrationDatabaseUrl: string;
  sessionSecret: Uint8Array;
  sessionSecretRaw: string;
  authMode: 'dev' | 'oidc';
  oidc: { issuer: string; internalIssuer: string; clientId: string; clientSecret: string; redirectUri: string; postLoginRedirect: string };
  vaultUrl: string;
  vaultToken: string;
  publicWebUrl: string;
  cookieSecure: boolean;
  consentSignatureAdapter: 'demo';
  today?: string;
}

export const DEMO_SESSION_SECRET = 'demo-session-secret-nur-fuer-lokale-entwicklung-0000';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Konfiguration fehlt: ${name}`);
  return v;
}

let cached: ApiConfig | undefined;

export function loadConfig(): ApiConfig {
  if (cached) return cached;
  const env = process.env.NODE_ENV ?? 'development';
  const secret = req('SESSION_SECRET');
  if (secret.length < 32) throw new Error('SESSION_SECRET muss mindestens 32 Zeichen lang sein');
  const cfg: ApiConfig = {
    env,
    port: Number(process.env.PORT ?? 4000),
    appDatabaseUrl: req('APP_DATABASE_URL'),
    migrationDatabaseUrl: req('MIGRATION_DATABASE_URL'),
    sessionSecret: new TextEncoder().encode(secret),
    sessionSecretRaw: secret,
    authMode: (process.env.AUTH_MODE as 'dev' | 'oidc') ?? 'dev',
    oidc: {
      issuer: process.env.OIDC_ISSUER ?? '',
      internalIssuer: process.env.OIDC_INTERNAL_ISSUER ?? process.env.OIDC_ISSUER ?? '',
      clientId: process.env.OIDC_CLIENT_ID ?? '',
      clientSecret: process.env.OIDC_CLIENT_SECRET ?? '',
      redirectUri: process.env.OIDC_REDIRECT_URI ?? '',
      postLoginRedirect: process.env.OIDC_POST_LOGIN_REDIRECT ?? '/',
    },
    vaultUrl: req('VAULT_URL'),
    vaultToken: req('VAULT_TOKEN_API'),
    publicWebUrl: process.env.PUBLIC_WEB_URL ?? 'http://localhost:3000',
    cookieSecure: process.env.COOKIE_SECURE === 'true',
    consentSignatureAdapter: 'demo',
    today: process.env.DART_TODAY,
  };
  if (env === 'production') {
    const problems: string[] = [];
    if (secret === DEMO_SESSION_SECRET || secret.startsWith('demo')) problems.push('Demo-Sitzungsgeheimnis');
    if (cfg.authMode === 'dev') problems.push('Entwicklungs-Anmeldung (AUTH_MODE=dev)');
    if (cfg.vaultToken.startsWith('demo-')) problems.push('Demo-Vault-Token');
    if (cfg.consentSignatureAdapter === 'demo') problems.push('Demo-Signaturadapter (kein produktives Signaturverfahren freigegeben)');
    if (!cfg.cookieSecure) problems.push('Cookies ohne Secure-Flag');
    if (cfg.today) problems.push('DART_TODAY (Testdatum) gesetzt');
    if (Number(process.env.RATE_LIMIT_MULTIPLIER ?? 1) !== 1) problems.push('RATE_LIMIT_MULTIPLIER (Testwert) gesetzt');
    if (problems.length) throw new Error(`Produktionsstart verweigert: ${problems.join(', ')}`);
  }
  cached = cfg;
  return cfg;
}

/** Heutiges Datum in Europe/Berlin (für Tests über DART_TODAY überschreibbar, nie in Produktion). */
export function todayBerlin(): string {
  const t = loadConfig().today;
  if (t) return t;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
