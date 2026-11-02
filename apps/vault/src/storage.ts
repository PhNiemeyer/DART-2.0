import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { VaultConfig } from './config';

/** Privater Objektspeicher; Objekte sind bereits vor dem Speichern verschlüsselt. Keine öffentlichen URLs. */
export interface ObjectStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  ready(): Promise<void>;
}

export function createStorage(cfg: VaultConfig): ObjectStorage {
  if (cfg.storage === 's3') {
    const client = new S3Client({
      endpoint: cfg.s3.endpoint,
      region: cfg.s3.region,
      forcePathStyle: cfg.s3.forcePathStyle,
      credentials: cfg.s3.accessKeyId ? { accessKeyId: cfg.s3.accessKeyId, secretAccessKey: cfg.s3.secretAccessKey ?? '' } : undefined,
    });
    return {
      async ready() {
        try {
          await client.send(new HeadBucketCommand({ Bucket: cfg.s3.bucket }));
        } catch {
          await client.send(new CreateBucketCommand({ Bucket: cfg.s3.bucket }));
        }
      },
      async put(key, data) {
        await client.send(new PutObjectCommand({ Bucket: cfg.s3.bucket, Key: key, Body: data, ContentType: 'application/octet-stream' }));
      },
      async get(key) {
        const r = await client.send(new GetObjectCommand({ Bucket: cfg.s3.bucket, Key: key }));
        return Buffer.from(await r.Body!.transformToByteArray());
      },
    };
  }
  const base = resolve(cfg.localDir);
  const path = (key: string) => {
    if (!/^[a-z0-9/-]+$/.test(key)) throw new Error('Ungültiger Objektschlüssel');
    return join(base, key);
  };
  return {
    async ready() {
      await mkdir(base, { recursive: true });
    },
    async put(key, data) {
      const p = path(key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, data, { mode: 0o600 });
    },
    async get(key) {
      return readFile(path(key));
    },
  };
}
