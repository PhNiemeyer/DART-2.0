import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { compare, GroupStat, MIN_GROUP, MODULE_LABELS, OPS_EXAMPLES } from '@dart/domain';
import { SCORE_REGISTRY } from '@dart/forms';
import { Request } from 'express';
import { z } from 'zod';
import { Audit } from '../core/audit';
import { Actor, centersWith, CurrentActor, Perm } from '../core/auth';
import { todayBerlin } from '../core/config';
import { Db, Tx } from '../core/db';
import { ApiError, notFound, requestIdOf } from '../core/errors';
import { parse } from '../core/http';

/**
 * Autoreport mit Benchmarking (deskriptiv, nicht risikoadjustiert).
 * - Eigene Daten (Operateur bzw. Zentrum) und Zentrum: Abfragen unter RLS des Nutzers.
 * - Gesamtkollektiv: ausschließlich aggregiert über SECURITY-DEFINER-Funktion ohne Zentrums-/Operateurfilter,
 *   Gruppen < 5 unterdrückt. Es werden nie Einzelfälle oder Werte anderer Zentren ausgegeben.
 */
const Q = z.object({
  ebene: z.enum(['operateur', 'zentrum']).default('operateur'),
  centerId: z.string().uuid().optional(),
  score: z.string().refine((s) => s in SCORE_REGISTRY, 'Unbekannter Score').default('IKDC@1'),
  timepoint: z.enum(['BL', 'M6', 'M12', 'M24', 'M36', 'M60']).default('M12'),
  dimension: z.enum(['modul', 'eingriff', 'modus', 'behandlung']).default('modul'),
  delta: z.enum(['true', 'false']).default('false'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const CONCEPT_LABELS = Object.fromEntries(OPS_EXAMPLES.map((o) => [o.concept, o.label.replace(' (Beispiel)', '')]));
const GROUP_LABELS: Record<string, string> = {
  ...MODULE_LABELS,
  ...CONCEPT_LABELS,
  NUR_BASIS: 'Nur Basis (ohne Zusatzmodul)',
  OHNE_EINGRIFF: 'Ohne erfassten Eingriff',
  GESAMT: 'Alle Fälle',
  basic: 'DART Basic',
  science: 'DART Science',
  operativ: 'Operativ',
  konservativ: 'Konservativ',
};
const TIMEPOINTS = ['BL', 'M6', 'M12', 'M24', 'M36', 'M60'];

type Row = { gruppe: string; n: number; mean: number | null; sd: number | null };
type Char = { merkmal: string; auspraegung: string; n: number | null; mean: number | null };

const suppress = (r: Row | undefined): GroupStat => (!r ? { n: 0, mean: null, sd: null } : r.n < MIN_GROUP ? { n: r.n, mean: null, sd: null } : { n: r.n, mean: r.mean, sd: r.sd });

@ApiTags('Auswertung')
@Controller('api/v1/reports')
export class AutoReportController {
  constructor(private readonly db: Db, private readonly audit: Audit) {}

  @Get('auto')
  @Perm('report.read')
  async auto(@CurrentActor() actor: Actor, @Query() query: Record<string, string>, @Req() req: Request) {
    const q = parse(Q, query);
    const centers = centersWith(actor, 'report.read');
    if (q.centerId && !centers.includes(q.centerId)) throw notFound();
    const isSurgeon = actor.roles.some((r) => r.role === 'arzt');
    if (q.ebene === 'operateur' && !isSurgeon) throw new ApiError(400, 'VALIDIERUNG', 'Die Ebene „Operateur“ steht nur Ärztinnen und Ärzten zur Verfügung.');
    const centerScope = q.centerId ? [q.centerId] : centers;
    const surgeon = q.ebene === 'operateur' ? actor.userId : null;
    const delta = q.delta === 'true';
    const alg = SCORE_REGISTRY[q.score];
    const from = q.from ?? null;
    const to = q.to ?? null;

    return this.db.tx({ centerIds: centerScope }, async (c) => {
      const scores = async (tp: string, dim: string, own: boolean, withSurgeon: boolean): Promise<Row[]> => {
        const r = own
          ? await c.query('SELECT * FROM report_scores_raw($1,$2,$3,$4,$5,$6,$7,$8)', [q.score, tp, dim, from, to, delta, centerScope, withSurgeon ? surgeon : null])
          : await c.query('SELECT * FROM report_scores_gesamt($1,$2,$3,$4,$5,$6)', [q.score, tp, dim, from, to, delta]);
        return r.rows;
      };
      const chars = async (own: boolean, withSurgeon: boolean): Promise<Char[]> =>
        (own
          ? await c.query('SELECT * FROM report_characteristics_raw($1,$2,$3,$4)', [from, to, centerScope, withSurgeon ? surgeon : null])
          : await c.query('SELECT * FROM report_characteristics_gesamt($1,$2)', [from, to])
        ).rows;

      // Merkmale
      const [ce, cz, cg] = await Promise.all([chars(true, q.ebene === 'operateur'), q.ebene === 'operateur' ? chars(true, false) : Promise.resolve(null), chars(false, false)]);
      const tot = (rows: Char[] | null) => rows?.find((r) => r.merkmal === 'faelle')?.n ?? null;
      const MISSING = ['unbekannt', 'nicht erfasst'];
      // Anteile bezogen auf Fälle mit erfasstem Merkmal; fehlende Angaben separat bezogen auf alle Fälle
      const known = (rows: Char[] | null, merkmal: string) => (rows ?? []).filter((r) => r.merkmal === merkmal && !MISSING.includes(r.auspraegung)).reduce((a, r) => a + (r.n ?? 0), 0);
      const keyOf = (r: Char) => `${r.merkmal}|${r.auspraegung}`;
      const order = (k: string) => {
        const a = k.split('|')[1];
        if (MISSING.includes(a)) return `zzz${a}`;
        if (a === '<18') return '00';
        return /^\d/.test(a) ? a.padStart(5, '0') : a;
      };
      const keys = [...new Set([...ce, ...(cz ?? []), ...cg].filter((r) => r.merkmal !== 'faelle').map(keyOf))].sort((x, y) => x.split('|')[0].localeCompare(y.split('|')[0]) || order(x).localeCompare(order(y)));
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const cell = (rows: Char[] | null, k: string, _total: number | null) => {
        if (!rows) return null;
        const [m, a] = k.split('|');
        const denom = MISSING.includes(a) ? tot(rows) : known(rows, m);
        const r = rows.find((x) => keyOf(x) === k);
        if (!r) return { n: 0, anteil: denom ? 0 : null, mittelwert: null };
        const small = r.n !== null && r.n > 0 && r.n < MIN_GROUP;
        return { n: small ? null : r.n, klein: small || r.n === null, anteil: r.n !== null && !small && denom ? Math.round((r.n / denom) * 1000) / 10 : null, mittelwert: small ? null : r.mean };
      };
      const merkmale = keys.map((k) => {
        const [merkmal, auspraegung] = k.split('|');
        return { merkmal, auspraegung, eigen: cell(ce, k, tot(ce)), zentrum: cell(cz, k, tot(cz)), gesamt: cell(cg, k, tot(cg)) };
      });

      // Outcome nach Gruppe
      const [oe, oz, og] = await Promise.all([scores(q.timepoint, q.dimension, true, q.ebene === 'operateur'), q.ebene === 'operateur' ? scores(q.timepoint, q.dimension, true, false) : Promise.resolve(null), scores(q.timepoint, q.dimension, false, false)]);
      const [ae, ag] = await Promise.all([scores(q.timepoint, 'gesamt', true, q.ebene === 'operateur'), scores(q.timepoint, 'gesamt', false, false)]);
      const groups = [...new Set([...og.map((r) => r.gruppe), ...oe.map((r) => r.gruppe)])].sort((a, b) => (GROUP_LABELS[a] ?? a).localeCompare(GROUP_LABELS[b] ?? b, 'de'));
      const line = (gruppe: string, e: Row[], z: Row[] | null, g: Row[]) => {
        const eigen = suppress(e.find((r) => r.gruppe === gruppe));
        const gesamt = suppress(g.find((r) => r.gruppe === gruppe));
        return { gruppe, label: GROUP_LABELS[gruppe] ?? gruppe, eigen, zentrum: z ? suppress(z.find((r) => r.gruppe === gruppe)) : null, gesamt, vergleich: compare(eigen, gesamt) };
      };
      const outcome = groups.map((g) => line(g, oe, oz, og));
      const alle = line('GESAMT', ae, null, ag);

      // Verlauf über die Zeitpunkte (alle Fälle)
      const verlauf = [];
      for (const tp of TIMEPOINTS) {
        if (delta && tp === 'BL') continue;
        const [e, g] = await Promise.all([scores(tp, 'gesamt', true, q.ebene === 'operateur'), scores(tp, 'gesamt', false, false)]);
        const eigen = suppress(e[0]);
        const gesamt = suppress(g[0]);
        verlauf.push({ timepoint: tp, eigen, gesamt, vergleich: compare(eigen, gesamt) });
      }
      await this.audit.write(c as Tx, actor, { action: 'autoreport', objectType: 'bericht', objectId: `${q.ebene}:${q.score}:${q.timepoint}`, requestId: requestIdOf(req) });
      return {
        stichtag: todayBerlin(),
        filter: { ...q, zentren: centerScope.length },
        ebenen: { eigen: q.ebene === 'operateur' ? `Eigene Fälle (${actor.displayName})` : 'Eigenes Zentrum', zentrum: q.ebene === 'operateur' ? 'Eigenes Zentrum' : null, gesamt: 'Gesamtkollektiv (alle Zentren, einschließlich eigener Fälle)' },
        score: { ref: q.score, name: alg.name, status: alg.status, quelle: alg.quelle ?? null, richtung: alg.direction, bereich: alg.range, einheit: alg.unit },
        merkmale,
        alleFaelle: alle,
        outcome,
        verlauf,
        hinweise: [
          `Deskriptiver Vergleich, nicht risikoadjustiert; kein Wirksamkeitsnachweis und keine Rangliste.`,
          `Gruppen mit weniger als ${MIN_GROUP} Fällen werden unterdrückt. Fälle mit mehreren Modulen/Eingriffen erscheinen in mehreren Gruppen.`,
          `Einordnung „über/unter“ nur, wenn das 95-%-Konfidenzintervall der eigenen Gruppe den Wert des Gesamtkollektivs nicht einschließt.`,
          alg.status !== 'freigegeben' ? `Scoringverfahren ${alg.name}: ${alg.status === 'demonstration' ? 'Demonstration' : 'wissenschaftliche Freigabe ausstehend'} (E-09).` : `Scoringverfahren freigegeben.`,
          `Prototyp mit synthetischen Daten.`,
        ],
      };
    });
  }
}
