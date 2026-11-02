import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../core/auth';
import { loadConfig } from '../core/config';
import { Db } from '../core/db';

@ApiTags('Betrieb')
@Controller('api')
@Public()
export class HealthController {
  constructor(private readonly db: Db) {}

  @Get('health')
  async health() {
    await this.db.app.query('SELECT 1');
    const cfg = loadConfig();
    let vault = 'unbekannt';
    try {
      const r = await fetch(`${cfg.vaultUrl}/health`);
      vault = r.ok ? 'ok' : 'fehler';
    } catch {
      vault = 'nicht erreichbar';
    }
    return { status: 'ok', dienst: 'api', datenbank: 'ok', vault, umgebung: cfg.env, hinweis: 'Prototyp – nur synthetische Daten' };
  }
}
