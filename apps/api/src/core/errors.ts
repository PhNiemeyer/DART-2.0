import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { ERROR_CODES, ErrorCode } from '@dart/contracts';
import { Request, Response } from 'express';
import { ZodError } from 'zod';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message?: string,
    public readonly details?: Array<{ path: string; message: string }>,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message ?? ERROR_CODES[code]);
  }
}

export const notFound = () => new ApiError(404, 'NICHT_GEFUNDEN');
export const forbidden = (msg?: string) => new ApiError(403, 'KEINE_BERECHTIGUNG', msg);
export const invalid = (msg: string, details?: Array<{ path: string; message: string }>) => new ApiError(400, 'VALIDIERUNG', msg, details);
export const conflict = (code: ErrorCode, msg?: string, extra?: Record<string, unknown>) => new ApiError(409, code, msg, undefined, extra);

export function requestIdOf(req: Request): string {
  return (req as Request & { requestId?: string }).requestId ?? 'unbekannt';
}

/** Einheitliche Fehlerantwort mit deutscher Meldung und request_id, ohne Debugdetails. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const request_id = requestIdOf(req);
    res.setHeader('Cache-Control', 'no-store');
    if (exception instanceof ApiError) {
      return res.status(exception.status).json({ code: exception.code, message: exception.message, request_id, details: exception.details, ...exception.extra });
    }
    if (exception instanceof ZodError) {
      return res.status(400).json({
        code: 'VALIDIERUNG',
        message: ERROR_CODES.VALIDIERUNG,
        request_id,
        details: exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code: ErrorCode = status === 404 ? 'NICHT_GEFUNDEN' : status === 401 ? 'NICHT_ANGEMELDET' : status === 403 ? 'KEINE_BERECHTIGUNG' : status === 413 ? 'UPLOAD_ABGELEHNT' : status === 429 ? 'ZU_VIELE_VERSUCHE' : 'VALIDIERUNG';
      return res.status(status).json({ code, message: ERROR_CODES[code], request_id });
    }
    const pgCode = (exception as { code?: string }).code;
    if (pgCode === '42501') return res.status(403).json({ code: 'KEINE_BERECHTIGUNG', message: ERROR_CODES.KEINE_BERECHTIGUNG, request_id });
    if (pgCode === '23505') return res.status(409).json({ code: 'KONFLIKT', message: 'Der Datensatz existiert bereits.', request_id });
    if ((exception as { type?: string }).type === 'entity.too.large') return res.status(413).json({ code: 'UPLOAD_ABGELEHNT', message: 'Die Datei ist zu groß.', request_id });
    // Datensparsames Betriebslog: kein Request-Body, keine Antworten, keine Tokens
    console.error(JSON.stringify({ level: 'error', dienst: 'api', request_id, pfad: req.route?.path ?? 'unbekannt', fehler: (exception as Error)?.name, pg: pgCode, meldung: String((exception as Error)?.message ?? '').slice(0, 160) }));
    return res.status(500).json({ code: 'INTERN', message: ERROR_CODES.INTERN, request_id });
  }
}
