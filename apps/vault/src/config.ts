/** Konfiguration des Identity Vault. Produktionsstart mit Demo-Geheimnissen/Testadaptern wird verweigert. */
export const DEMO_DATA_KEY = 'ZGVtby1kZW1vLWRlbW8tZGVtby1kZW1vLWRlbW8tMzI='; // nur lokal
export const DEMO_INDEX_KEY = 'ZGVtby1pbmRleC1rZXktbnVyLWxva2FsLWVudHdpY2s=';

export interface VaultConfig {
  env: string;
  port: number;
  databaseUrl: string;
  dataKey: Buffer;
  indexKey: Buffer;
  callers: Record<string, string>; // token -> caller name
  storage: 'local' | 's3';
  localDir: string;
  s3: { endpoint?: string; bucket: string; region: string; accessKeyId?: string; secretAccessKey?: string; forcePathStyle: boolean };
  scanner: 'demo';
  maxUploadBytes: number;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Konfiguration fehlt: ${name}`);
  return v;
}

export function loadConfig(): VaultConfig {
  const env = process.env.NODE_ENV ?? 'development';
  const dataKeyB64 = req('VAULT_DATA_KEY');
  const indexKeyB64 = req('VAULT_INDEX_KEY');
  const dataKey = Buffer.from(dataKeyB64, 'base64');
  const indexKey = Buffer.from(indexKeyB64, 'base64');
  if (dataKey.length !== 32) throw new Error('VAULT_DATA_KEY muss 32 Byte (Base64) lang sein');
  if (indexKey.length < 32) throw new Error('VAULT_INDEX_KEY muss mindestens 32 Byte (Base64) lang sein');
  const callers: Record<string, string> = {};
  callers[req('VAULT_TOKEN_API')] = 'api';
  callers[req('VAULT_TOKEN_WORKER')] = 'worker';
  const cfg: VaultConfig = {
    env,
    port: Number(process.env.PORT ?? 4100),
    databaseUrl: req('VAULT_DATABASE_URL'),
    dataKey,
    indexKey,
    callers,
    storage: (process.env.VAULT_STORAGE as 'local' | 's3') ?? 'local',
    localDir: process.env.VAULT_LOCAL_DIR ?? './var/vault-objects',
    s3: {
      endpoint: process.env.S3_ENDPOINT,
      bucket: process.env.S3_BUCKET ?? 'dart-vault',
      region: process.env.S3_REGION ?? 'eu-central-1',
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    },
    scanner: 'demo',
    maxUploadBytes: Number(process.env.VAULT_MAX_UPLOAD_BYTES ?? 20 * 1024 * 1024),
  };
  if (env === 'production') {
    const problems: string[] = [];
    if (dataKeyB64 === DEMO_DATA_KEY || indexKeyB64 === DEMO_INDEX_KEY) problems.push('Demo-Schlüssel');
    if (Object.keys(callers).some((t) => t.startsWith('demo-'))) problems.push('Demo-Diensttokens');
    if (cfg.storage === 'local') problems.push('lokaler Dateispeicher');
    if (cfg.scanner === 'demo') problems.push('Demo-Malwarescanner (kein produktiver Scanner angebunden)');
    if (problems.length) throw new Error(`Produktionsstart verweigert: ${problems.join(', ')}`);
  }
  return cfg;
}
