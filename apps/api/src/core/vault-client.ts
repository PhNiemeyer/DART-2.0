import { Injectable } from '@nestjs/common';
import { loadConfig } from './config';
import { ApiError } from './errors';

export interface VaultCtx {
  centerIds: string[];
  actor: string;
  requestId?: string;
}

/** Client für den Identity Vault (separate Sicherheitsgrenze, Diensttoken). */
@Injectable()
export class VaultClient {
  private async call<T>(ctx: VaultCtx, method: string, path: string, body?: unknown, okStatuses = [200, 201]): Promise<{ status: number; data: T }> {
    const cfg = loadConfig();
    let res: Response;
    try {
      res = await fetch(`${cfg.vaultUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${cfg.vaultToken}`,
          'content-type': 'application/json',
          'x-dart-center-ids': ctx.centerIds.join(','),
          'x-dart-actor': ctx.actor,
          'x-request-id': ctx.requestId ?? '',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(503, 'INTERN', 'Der Identitätsdienst ist nicht erreichbar.');
    }
    const data = (await res.json().catch(() => ({}))) as T;
    if (res.status === 404) throw new ApiError(404, 'NICHT_GEFUNDEN');
    if (!okStatuses.includes(res.status)) {
      if (res.status === 400) throw new ApiError(400, 'VALIDIERUNG', 'Identitätsdaten ungültig');
      if (res.status === 413) throw new ApiError(413, 'UPLOAD_ABGELEHNT', 'Die Datei ist zu groß.');
      throw new ApiError(502, 'INTERN', 'Fehler im Identitätsdienst');
    }
    return { status: res.status, data };
  }

  createIdentity(ctx: VaultCtx, b: { centerId: string; firstName: string; lastName: string; email?: string | null; birthDate?: string | null; synthetic: boolean }) {
    return this.call<{ vaultRef: string }>(ctx, 'POST', '/internal/v1/identities', b).then((r) => r.data);
  }
  getIdentity(ctx: VaultCtx, ref: string) {
    return this.call<{ vaultRef: string; firstName: string; lastName: string; email: string | null; birthDate: string | null; hasAccessCode: boolean }>(ctx, 'GET', `/internal/v1/identities/${ref}`).then((r) => r.data);
  }
  batch(ctx: VaultCtx, refs: string[]) {
    return this.call<{ items: Array<{ vaultRef: string; firstName: string; lastName: string }> }>(ctx, 'POST', '/internal/v1/identities/batch', { refs }).then((r) => r.data.items);
  }
  search(ctx: VaultCtx, lastName: string) {
    return this.call<{ vaultRefs: string[] }>(ctx, 'POST', '/internal/v1/identities/search', { lastName }).then((r) => r.data.vaultRefs);
  }
  newAccessCode(ctx: VaultCtx, ref: string) {
    return this.call<{ accessCode: string }>(ctx, 'POST', `/internal/v1/identities/${ref}/access-code`, {}).then((r) => r.data.accessCode);
  }
  verifyAccessCode(ctx: VaultCtx, ref: string, code: string) {
    return this.call<{ ok: boolean }>(ctx, 'POST', `/internal/v1/identities/${ref}/verify-access-code`, { code }).then((r) => r.data.ok);
  }
  storeDocument(ctx: VaultCtx, b: { vaultRef: string; kind: 'einwilligung_papier' | 'signatur_demo' | 'einwilligung_kopie'; originalName?: string; contentType: string; contentBase64: string }) {
    return this.call<{ documentId: string; sha256: string; scanStatus: 'sauber' | 'infiziert' | 'abgelehnt' | 'quarantaene'; detail: string; contentType: string }>(ctx, 'POST', '/internal/v1/documents', b, [201, 422]).then((r) => r.data);
  }
  getDocument(ctx: VaultCtx, id: string) {
    return this.call<{ documentId: string; contentType: string; sha256: string; kind: string; contentBase64: string }>(ctx, 'GET', `/internal/v1/documents/${id}`).then((r) => r.data);
  }
}
