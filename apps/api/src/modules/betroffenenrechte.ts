import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FormItem, FormSchema } from '@dart/forms';
import { Request } from 'express';
import { z } from 'zod';
import { Audit } from '../core/audit';
import { Actor, can, centersWith, CurrentActor, Perm } from '../core/auth';
import { todayBerlin } from '../core/config';
import { Db, Tx } from '../core/db';
import { conflict, forbidden, invalid, notFound, requestIdOf } from '../core/errors';
import { parse } from '../core/http';
import { VaultClient } from '../core/vault-client';

export const DSR_KINDS = ['auskunft', 'berichtigung', 'einschraenkung', 'widerruf', 'loeschung'] as const;
const OPEN = ['offen', 'in_bearbeitung'];
const Reason = z.string().trim().min(5, 'Bitte eine Begründung angeben (mind. 5 Zeichen)').max(2000);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const KIND_DE: Record<string, string> = { auskunft: 'Auskunft', berichtigung: 'Berichtigung', einschraenkung: 'Einschränkung', widerruf: 'Widerruf', loeschung: 'Löschung' };
const CHANNEL_DE: Record<string, string> = { schriftlich: 'schriftlich', persoenlich: 'persönlich', telefonisch: 'telefonisch', email: 'per E-Mail', portal: 'über das Portal' };
const IDENT_DE: Record<string, string> = { persoenlich_ausweis: 'persönlich mit Ausweis', portal_zugangscode: 'Portal mit Zugangscode', schriftlich_unterschrift: 'schriftlich mit Unterschriftenabgleich', rueckruf_bekannte_nummer: 'Rückruf unter bekannter Nummer' };
const deDate = (iso: string) => iso.split('-').reverse().join('.');

/**
 * Betroffenenrechte (R-19, Lastenheft D03): Auskunft, Berichtigung, Einschränkung, Widerruf, Löschung.
 * Bearbeitung durch das Zentrum (Entscheidung des Auftraggebers): Dokumentation und Zentrumsverantwortliche erfassen,
 * Zentrumsverantwortliche bearbeiten und schließen ab. Die zentrale Administration sieht nur Anzahlen und Fristen.
 * Frist: ein Monat ab Eingang, einmalig um zwei Monate verlängerbar mit Begründung (Art. 12 Abs. 3 DSGVO; Vorschlag, E-20).
 * Löschung wird vorbereitet (Sperre und Übersicht je Datenklasse), nicht automatisch ausgeführt (E-07).
 */
@ApiTags('Betroffenenrechte')
@Controller('api/v1/dsr')
export class DsrController {
  constructor(private readonly db: Db, private readonly audit: Audit, private readonly vault: VaultClient) {}

  private async event(c: Tx, r: { id: string; center_id: string }, actor: Actor, action: string, detail?: string | null) {
    await c.query('INSERT INTO data_subject_request_event (request_id, center_id, actor_user_id, action, detail) VALUES ($1,$2,$3,$4,$5)', [r.id, r.center_id, actor.userId, action, detail ?? null]);
    await c.query(`UPDATE data_subject_request SET updated_at = now(), status = CASE WHEN status = 'offen' AND $2 <> 'erfasst' THEN 'in_bearbeitung' ELSE status END WHERE id = $1`, [r.id, action]);
  }

  private async load(c: Tx, id: string, lock = false) {
    const r = (await c.query(`SELECT d.*, COALESCE(d.extended_due_date, d.due_date) AS frist FROM data_subject_request d WHERE d.id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id])).rows[0];
    if (!r) throw notFound();
    return r;
  }

  @Get('summary')
  async summary(@CurrentActor() actor: Actor) {
    if (can(actor, 'dsr.record')) {
      return this.db.tx({ centerIds: centersWith(actor, 'dsr.record') }, async (c) => {
        const r = (await c.query(
          `SELECT count(*) FILTER (WHERE status IN ('offen','in_bearbeitung'))::int AS offen,
                  count(*) FILTER (WHERE status IN ('offen','in_bearbeitung') AND COALESCE(extended_due_date, due_date) < $1::date)::int AS ueberfaellig,
                  count(*) FILTER (WHERE status IN ('offen','in_bearbeitung') AND COALESCE(extended_due_date, due_date) BETWEEN $1::date AND $1::date + 7)::int AS bald_faellig,
                  count(*) FILTER (WHERE status IN ('erledigt','abgelehnt'))::int AS abgeschlossen
             FROM data_subject_request`,
          [todayBerlin()],
        )).rows[0];
        return { ebene: 'zentrum', ...r };
      });
    }
    if (can(actor, 'dsr.overview')) {
      return { ebene: 'zentral', byCenter: (await this.db.app.query('SELECT * FROM dsr_overview()')).rows, hinweis: 'Nur Anzahlen je Zentrum; Bearbeitung im Zentrum.' };
    }
    throw forbidden();
  }

  @Get()
  @Perm('dsr.record')
  async list(@CurrentActor() actor: Actor, @Query() query: Record<string, string>) {
    const q = parse(z.object({ status: z.enum(['offen', 'ueberfaellig', 'abgeschlossen', 'alle']).default('offen'), caseId: z.string().uuid().optional() }), query);
    return this.db.tx({ centerIds: centersWith(actor, 'dsr.record') }, async (c) => {
      const items = (await c.query(
        `SELECT d.id, d.kind, d.status, d.received_at, d.channel, d.due_date, d.extended_due_date, COALESCE(d.extended_due_date, d.due_date) AS frist,
                (COALESCE(d.extended_due_date, d.due_date) - $3::date) AS tage_bis_frist, d.identity_method IS NOT NULL AS identitaet_geprueft,
                d.case_id, tc.case_no, p.pseudonym, (p.restricted_at IS NOT NULL) AS eingeschraenkt, ce.code AS center_code, d.closed_at
           FROM data_subject_request d JOIN patient p ON p.id = d.patient_id JOIN center ce ON ce.id = d.center_id
           LEFT JOIN treatment_case tc ON tc.id = d.case_id
          WHERE ($1 = 'alle'
             OR ($1 = 'offen' AND d.status IN ('offen','in_bearbeitung'))
             OR ($1 = 'ueberfaellig' AND d.status IN ('offen','in_bearbeitung') AND COALESCE(d.extended_due_date, d.due_date) < $3::date)
             OR ($1 = 'abgeschlossen' AND d.status IN ('erledigt','abgelehnt')))
            AND ($2::uuid IS NULL OR d.case_id = $2)
          ORDER BY (d.status IN ('offen','in_bearbeitung')) DESC, COALESCE(d.extended_due_date, d.due_date), d.created_at
          LIMIT 200`,
        [q.status, q.caseId ?? null, todayBerlin()],
      )).rows;
      return { items };
    });
  }

  /** Antrag erfassen (Dokumentation oder Zentrumsverantwortliche). Frist: Eingang + 1 Monat. */
  @Post()
  @Perm('dsr.record')
  async create(@CurrentActor() actor: Actor, @Body() body: unknown, @Req() req: Request) {
    const b = parse(
      z.object({
        caseId: z.string().uuid(),
        kind: z.enum(DSR_KINDS),
        receivedAt: IsoDate,
        channel: z.enum(['schriftlich', 'persoenlich', 'telefonisch', 'email', 'portal']),
        note: z.string().trim().max(2000).optional(),
      }),
      body,
    );
    return this.db.tx({ centerIds: centersWith(actor, 'dsr.record') }, async (c) => {
      const tc = (await c.query('SELECT id, patient_id, center_id FROM treatment_case WHERE id = $1', [b.caseId])).rows[0];
      if (!tc) throw notFound();
      // Kalendertag in Deutschland (nicht UTC): sonst gilt „heute“ zwischen Mitternacht und 1/2 Uhr als Zukunft
      if (b.receivedAt > todayBerlin()) throw invalid('Das Eingangsdatum liegt in der Zukunft.');
      const r = (await c.query(
        `INSERT INTO data_subject_request (center_id, patient_id, case_id, kind, received_at, channel, due_date, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6, ($5::date + interval '1 month')::date, $7, $8) RETURNING id, center_id, due_date`,
        [tc.center_id, tc.patient_id, tc.id, b.kind, b.receivedAt, b.channel, b.note || null, actor.userId],
      )).rows[0];
      await this.event(c, r, actor, 'erfasst', `${KIND_DE[b.kind]}, Eingang ${deDate(b.receivedAt)} (${CHANNEL_DE[b.channel]})`);
      await this.audit.write(c, actor, { action: 'betroffenenantrag_erfassen', objectType: 'betroffenenantrag', objectId: r.id, centerId: r.center_id, requestId: requestIdOf(req) });
      return { id: r.id, dueDate: r.due_date };
    });
  }

  @Get(':id')
  @Perm('dsr.record')
  async detail(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx({ centerIds: centersWith(actor, 'dsr.record') }, async (c) => {
      const r = await this.load(c, id);
      const p = (await c.query('SELECT pseudonym, restricted_at, restricted_reason, restricted_request_id FROM patient WHERE id = $1', [r.patient_id])).rows[0];
      const tc = r.case_id ? (await c.query('SELECT case_no FROM treatment_case WHERE id = $1', [r.case_id])).rows[0] : null;
      const events = (await c.query(
        `SELECT e.action, e.detail, e.created_at, u.display_name AS actor FROM data_subject_request_event e LEFT JOIN app_user u ON u.id = e.actor_user_id WHERE e.request_id = $1 ORDER BY e.id`,
        [id],
      )).rows;
      const manage = can(actor, 'dsr.manage', r.center_id);
      const open = OPEN.includes(r.status);
      const restrictable = ['einschraenkung', 'loeschung'].includes(r.kind);
      return {
        id: r.id, kind: r.kind, status: r.status, receivedAt: r.received_at, channel: r.channel, dueDate: r.due_date, extendedDueDate: r.extended_due_date,
        extensionReason: r.extension_reason, frist: r.frist, note: r.note, outcome: r.outcome, closedAt: r.closed_at,
        identity: r.identity_method ? { method: r.identity_method, at: r.identity_checked_at } : null,
        caseId: r.case_id, caseNo: tc?.case_no ?? null, pseudonym: p.pseudonym,
        restriction: p.restricted_at ? { at: p.restricted_at, reason: p.restricted_reason, byThisRequest: p.restricted_request_id === r.id } : null,
        events,
        actions: {
          identity: manage && open && !r.identity_method,
          extend: manage && open && !r.extended_due_date,
          restrict: manage && open && restrictable && !p.restricted_at && !!r.identity_method,
          lift: manage && r.kind === 'einschraenkung' && !!p.restricted_at && p.restricted_request_id === r.id,
          report: manage && r.kind === 'auskunft' && !!r.identity_method,
          deletionOverview: manage && r.kind === 'loeschung' && !!r.identity_method,
          close: manage && open,
        },
      };
    });
  }

  @Post(':id/identity')
  @Perm('dsr.manage')
  async identity(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({ method: z.enum(['persoenlich_ausweis', 'portal_zugangscode', 'schriftlich_unterschrift', 'rueckruf_bekannte_nummer']), note: z.string().trim().max(500).optional() }), body);
    return this.db.tx({ centerIds: centersWith(actor, 'dsr.manage') }, async (c) => {
      const r = await this.load(c, id, true);
      if (!OPEN.includes(r.status)) throw conflict('ZUSTAND_UNZULAESSIG', 'Der Antrag ist bereits abgeschlossen.');
      if (r.identity_method) throw conflict('ZUSTAND_UNZULAESSIG', 'Die Identität wurde bereits geprüft.');
      await c.query('UPDATE data_subject_request SET identity_method = $2, identity_checked_by = $3, identity_checked_at = now() WHERE id = $1', [id, b.method, actor.userId]);
      await this.event(c, r, actor, 'identitaet_geprueft', `${IDENT_DE[b.method]}${b.note ? ` – ${b.note}` : ''}`);
      await this.audit.write(c, actor, { action: 'betroffenenantrag_identitaet', objectType: 'betroffenenantrag', objectId: id, centerId: r.center_id, requestId: requestIdOf(req) });
      return { ok: true };
    });
  }

  /** Einmalige Verlängerung um zwei Monate, nur vor Fristablauf und mit Begründung (Mitteilung an die Person erforderlich). */
  @Post(':id/extend')
  @Perm('dsr.manage')
  async extend(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: Request) {
    const { reason } = parse(z.object({ reason: Reason }), body);
    return this.db.tx({ centerIds: centersWith(actor, 'dsr.manage') }, async (c) => {
      const r = await this.load(c, id, true);
      if (!OPEN.includes(r.status)) throw conflict('ZUSTAND_UNZULAESSIG', 'Der Antrag ist bereits abgeschlossen.');
      if (r.extended_due_date) throw conflict('ZUSTAND_UNZULAESSIG', 'Die Frist wurde bereits verlängert.');
      if ((await c.query('SELECT $1::date < $2::date AS late', [r.due_date, todayBerlin()])).rows[0].late) throw conflict('ZUSTAND_UNZULAESSIG', 'Die Frist ist bereits abgelaufen; eine Verlängerung ist nur innerhalb der Frist möglich.');
      const u = (await c.query(`UPDATE data_subject_request SET extended_due_date = (due_date + interval '2 months')::date, extension_reason = $2 WHERE id = $1 RETURNING extended_due_date`, [id, reason])).rows[0];
      await this.event(c, r, actor, 'frist_verlaengert', reason);
      await this.audit.write(c, actor, { action: 'betroffenenantrag_verlaengern', objectType: 'betroffenenantrag', objectId: id, centerId: r.center_id, reason, requestId: requestIdOf(req) });
      return { extendedDueDate: u.extended_due_date };
    });
  }

  /** Einschränkung der Verarbeitung (auch als Sofortmaßnahme bei Löschanträgen): keine Exporte, Auswertungen, Versand. */
  @Post(':id/restrict')
  @Perm('dsr.manage')
  async restrict(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: Request) {
    const { reason } = parse(z.object({ reason: Reason }), body);
    return this.db.tx({ centerIds: centersWith(actor, 'dsr.manage') }, async (c) => {
      const r = await this.load(c, id, true);
      if (!OPEN.includes(r.status) || !['einschraenkung', 'loeschung'].includes(r.kind)) throw conflict('ZUSTAND_UNZULAESSIG', 'Eine Einschränkung ist nur bei offenen Anträgen auf Einschränkung oder Löschung möglich.');
      if (!r.identity_method) throw conflict('ZUSTAND_UNZULAESSIG', 'Bitte zuerst die Identität prüfen.');
      const u = await c.query('UPDATE patient SET restricted_at = now(), restricted_reason = $2, restricted_request_id = $3 WHERE id = $1 AND restricted_at IS NULL', [r.patient_id, reason, id]);
      if (u.rowCount === 0) throw conflict('ZUSTAND_UNZULAESSIG', 'Die Verarbeitung ist bereits eingeschränkt.');
      // Offene Einladungen und Erinnerungen sofort stornieren; Links werden wirkungslos
      await c.query(`UPDATE outbox_message SET status = 'storniert', cancel_reason = 'Verarbeitung eingeschränkt', updated_at = now() WHERE patient_id = $1 AND status IN ('ausstehend','fehlgeschlagen','unklar','dead_letter')`, [r.patient_id]);
      await c.query(`UPDATE invitation SET status = 'widerrufen', revoked_at = now() WHERE patient_id = $1 AND status = 'aktiv'`, [r.patient_id]);
      await this.event(c, r, actor, 'verarbeitung_eingeschraenkt', reason);
      await this.audit.write(c, actor, { action: 'verarbeitung_einschraenken', objectType: 'patient', objectId: r.patient_id, centerId: r.center_id, reason, requestId: requestIdOf(req) });
      return { ok: true };
    });
  }

  @Post(':id/lift')
  @Perm('dsr.manage')
  async lift(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: Request) {
    const { reason } = parse(z.object({ reason: Reason }), body);
    return this.db.tx({ centerIds: centersWith(actor, 'dsr.manage') }, async (c) => {
      const r = await this.load(c, id, true);
      if (r.kind !== 'einschraenkung') throw conflict('ZUSTAND_UNZULAESSIG', 'Nur Einschränkungen aus einem Antrag auf Einschränkung können hier aufgehoben werden.');
      const u = await c.query('UPDATE patient SET restricted_at = NULL, restricted_reason = NULL, restricted_request_id = NULL WHERE id = $1 AND restricted_request_id = $2', [r.patient_id, id]);
      if (u.rowCount === 0) throw conflict('ZUSTAND_UNZULAESSIG', 'Keine Einschränkung aus diesem Antrag aktiv.');
      await this.event(c, r, actor, 'einschraenkung_aufgehoben', reason);
      await this.audit.write(c, actor, { action: 'verarbeitung_einschraenkung_aufheben', objectType: 'patient', objectId: r.patient_id, centerId: r.center_id, reason, requestId: requestIdOf(req) });
      return { ok: true };
    });
  }

  /** Auskunft (Art. 15): alle gespeicherten Daten der Person in lesbarer Form. Nur nach Identitätsprüfung; protokolliert. */
  @Get(':id/auskunft')
  @Perm('dsr.manage')
  async report(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    const data = await this.db.tx({ centerIds: centersWith(actor, 'dsr.manage') }, async (c) => {
      const r = await this.load(c, id);
      if (r.kind !== 'auskunft') throw conflict('ZUSTAND_UNZULAESSIG', 'Nur für Auskunftsanträge.');
      if (!r.identity_method) throw conflict('ZUSTAND_UNZULAESSIG', 'Bitte zuerst die Identität prüfen.');
      const p = (await c.query('SELECT id, pseudonym, vault_ref, sex, created_at, restricted_at FROM patient WHERE id = $1', [r.patient_id])).rows[0];
      const cases = (await c.query(
        `SELECT tc.id, tc.case_no, tc.joint, tc.side, tc.treatment_type, tc.status, tc.planned_op_date, tc.actual_op_date, tc.conservative_start_date, tc.age_group, ce.name AS zentrum,
                (SELECT mode FROM capture_mode_history h WHERE h.case_id = tc.id AND h.valid_to IS NULL) AS modus,
                COALESCE((SELECT array_agg(register_code ORDER BY register_code) FROM case_register_membership m WHERE m.case_id = tc.id AND m.valid_to IS NULL), '{}') AS register,
                COALESCE((SELECT array_agg(module_code ORDER BY module_code) FROM case_module m WHERE m.case_id = tc.id AND m.active), '{}') AS module
           FROM treatment_case tc JOIN center ce ON ce.id = tc.center_id WHERE tc.patient_id = $1 ORDER BY tc.created_at`,
        [p.id],
      )).rows;
      const consents = (await c.query(
        `SELECT cr.status, cr.method, cr.scopes, cr.signed_date, cr.created_at, d.title, d.version FROM consent_record cr LEFT JOIN consent_document_version d ON d.id = cr.document_version_id WHERE cr.patient_id = $1 ORDER BY cr.created_at`,
        [p.id],
      )).rows;
      const responses = (await c.query(
        `SELECT r.id, r.case_id, r.status, r.audience, r.updated_at, q.title, qv.version, qv.schema, e.timepoint
           FROM response r JOIN questionnaire_version qv ON qv.id = r.questionnaire_version_id JOIN questionnaire q ON q.id = qv.questionnaire_id
           LEFT JOIN assessment_event e ON e.id = r.assessment_event_id
          WHERE r.case_id = ANY($1) ORDER BY r.case_id, e.timepoint, q.title`,
        [cases.map((x) => x.id)],
      )).rows;
      const bogen = [];
      for (const rs of responses) {
        const labels = new Map<string, string>();
        for (const s of (rs.schema as FormSchema).sections) for (const it of s.items) { labels.set(it.id, it.label); for (const ch of (it as FormItem).items ?? []) labels.set(ch.id, ch.label); }
        const answers = (await c.query('SELECT item_id, value_text, value_number, value_date, value_codes, missing_reason FROM answer WHERE response_id = $1 AND active ORDER BY answer_key', [rs.id])).rows;
        const scores = (await c.query(`SELECT DISTINCT ON (answer_key, algorithm) algorithm, value FROM derived_score WHERE response_id = $1 ORDER BY answer_key, algorithm, response_revision DESC`, [rs.id])).rows;
        bogen.push({
          fall: cases.find((x) => x.id === rs.case_id)?.case_no, zeitpunkt: rs.timepoint, formular: `${rs.title} (Version ${rs.version})`, status: rs.status, stand: rs.updated_at,
          antworten: answers.map((a) => ({ frage: labels.get(a.item_id) ?? a.item_id, wert: a.missing_reason ? `Fehlgrund: ${a.missing_reason}` : a.value_codes?.length ? a.value_codes.join(', ') : a.value_text ?? a.value_number ?? a.value_date })),
          scores: scores.map((s) => ({ verfahren: s.algorithm, wert: s.value })),
        });
      }
      const kontakt = (await c.query('SELECT email_status, source, updated_at FROM contact_preference WHERE patient_id = $1', [p.id])).rows[0] ?? null;
      const versand = (await c.query(`SELECT kind, status, count(*)::int AS n FROM outbox_message WHERE patient_id = $1 GROUP BY kind, status ORDER BY kind, status`, [p.id])).rows;
      const zugriffe = (await c.query(`SELECT count(*)::int AS n FROM audit_event WHERE object_id = $1 OR object_id = ANY($2::text[])`, [p.id, cases.map((x) => x.id)])).rows[0].n;
      await this.event(c, r, actor, 'auskunft_erstellt', null);
      await this.audit.write(c, actor, { action: 'betroffenenantrag_auskunft', objectType: 'betroffenenantrag', objectId: id, centerId: r.center_id, requestId: requestIdOf(req) });
      return { r, p, cases, consents, bogen, kontakt, versand, zugriffe };
    });
    const ident = await this.vault.getIdentity({ centerIds: [data.r.center_id], actor: actor.userId, requestId: requestIdOf(req) }, data.p.vault_ref).catch(() => null);
    return {
      titel: 'Auskunft nach Art. 15 DSGVO – Entwurf (Prototyp, synthetische Daten)',
      stichtag: new Date().toISOString(),
      hinweis: 'Entwurf zur Prüfung durch das Zentrum. Angaben zu Zwecken, Empfängern, Speicherdauer und Rechten sind dem freigegebenen Informationstext zu entnehmen (E-07, E-08).',
      identitaet: ident ? { vorname: ident.firstName, nachname: ident.lastName, geburtsdatum: ident.birthDate, email: ident.email } : { hinweis: 'Identitätsdaten im Vault nicht abrufbar' },
      pseudonym: data.p.pseudonym,
      geschlecht: data.p.sex,
      eingeschraenkt: !!data.p.restricted_at,
      faelle: data.cases.map(({ id: _id, ...x }) => x),
      einwilligungen: data.consents,
      boegen: data.bogen,
      kontaktEmail: data.kontakt,
      versand: data.versand,
      protokollierteZugriffe: data.zugriffe,
    };
  }

  /** Löschübersicht: betroffene Daten je Datenklasse. Keine automatische Löschung (E-07). */
  @Get(':id/loeschuebersicht')
  @Perm('dsr.manage')
  async deletionOverview(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx({ centerIds: centersWith(actor, 'dsr.manage') }, async (c) => {
      const r = await this.load(c, id);
      if (r.kind !== 'loeschung') throw conflict('ZUSTAND_UNZULAESSIG', 'Nur für Löschanträge.');
      const n = async (sql: string) => (await c.query(sql, [r.patient_id])).rows[0].n as number;
      const caseSub = 'SELECT id FROM treatment_case WHERE patient_id = $1';
      const respSub = `SELECT id FROM response WHERE case_id IN (${caseSub})`;
      const klassen = [
        { klasse: 'Identität und Kontakt (Vault)', anzahl: 1, ort: 'Identity Vault', vorschlag: 'Löschen, sofern keine Aufbewahrungspflicht', entscheidung: 'offen' },
        { klasse: 'Einwilligungen und Nachweise', anzahl: await n('SELECT count(*)::int AS n FROM consent_record WHERE patient_id = $1'), ort: 'Kern + Vault (Dokumente)', vorschlag: 'Nachweis der Einwilligung ggf. aufbewahren (Rechenschaftspflicht)', entscheidung: 'offen' },
        { klasse: 'Behandlungsfälle', anzahl: await n(`SELECT count(*)::int AS n FROM (${caseSub}) x`), ort: 'Kern (pseudonym)', vorschlag: 'Löschen oder nachweisbar anonymisieren', entscheidung: 'offen' },
        { klasse: 'Bögen und Antworten', anzahl: await n(`SELECT count(*)::int AS n FROM answer WHERE response_id IN (${respSub})`), ort: 'Kern (pseudonym)', vorschlag: 'Löschen oder nachweisbar anonymisieren', entscheidung: 'offen' },
        { klasse: 'Berechnete Scores', anzahl: await n(`SELECT count(*)::int AS n FROM derived_score WHERE response_id IN (${respSub})`), ort: 'Kern (pseudonym)', vorschlag: 'Mit den Antworten', entscheidung: 'offen' },
        { klasse: 'Einladungen und Versand', anzahl: await n('SELECT count(*)::int AS n FROM outbox_message WHERE patient_id = $1'), ort: 'Kern', vorschlag: 'Löschen', entscheidung: 'offen' },
        { klasse: 'Bereits erstellte Exporte', anzahl: null, ort: 'Exportdateien (Objektspeicher)', vorschlag: 'Empfänger informieren, Löschung nach Matrix', entscheidung: 'offen' },
        { klasse: 'Fachaudit', anzahl: null, ort: 'Audit (nur anhängen)', vorschlag: 'Aufbewahren (Nachweis); keine Inhalte', entscheidung: 'offen' },
        { klasse: 'Sicherungen (Backups)', anzahl: null, ort: 'Backup', vorschlag: 'Löschentscheidung bei Wiederherstellung erneut anwenden', entscheidung: 'offen' },
      ];
      return {
        hinweis: 'Die endgültige Löschung wird nicht automatisch ausgeführt. Sie erfordert die freigegebene Lösch-/Aufbewahrungsmatrix (E-07) und erfolgt als manueller, protokollierter Schritt.',
        eingeschraenkt: !!(await c.query('SELECT restricted_at FROM patient WHERE id = $1', [r.patient_id])).rows[0].restricted_at,
        klassen,
      };
    });
  }

  /** Abschluss: erledigt (mit Ergebnis) oder abgelehnt (mit Begründung). Erledigt nur nach Identitätsprüfung. */
  @Post(':id/close')
  @Perm('dsr.manage')
  async close(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({ result: z.enum(['erledigt', 'abgelehnt']), outcome: Reason, manualDeletionConfirmed: z.boolean().optional() }), body);
    return this.db.tx({ centerIds: centersWith(actor, 'dsr.manage') }, async (c) => {
      const r = await this.load(c, id, true);
      if (!OPEN.includes(r.status)) throw conflict('ZUSTAND_UNZULAESSIG', 'Der Antrag ist bereits abgeschlossen.');
      if (b.result === 'erledigt') {
        if (!r.identity_method) throw conflict('ZUSTAND_UNZULAESSIG', 'Ein Antrag kann erst nach Identitätsprüfung als erledigt abgeschlossen werden.');
        if (r.kind === 'loeschung') {
          const p = (await c.query('SELECT restricted_at FROM patient WHERE id = $1', [r.patient_id])).rows[0];
          if (!p.restricted_at) throw conflict('ZUSTAND_UNZULAESSIG', 'Vor dem Abschluss eines Löschantrags muss die Verarbeitung eingeschränkt sein.');
          if (!b.manualDeletionConfirmed) throw conflict('ZUSTAND_UNZULAESSIG', 'Bitte bestätigen Sie, dass die Löschung nach freigegebener Matrix manuell durchgeführt und dokumentiert wurde.');
        }
      }
      await c.query(`UPDATE data_subject_request SET status = $2, outcome = $3, closed_by = $4, closed_at = now(), updated_at = now() WHERE id = $1`, [id, b.result, b.outcome, actor.userId]);
      await this.event(c, r, actor, b.result === 'erledigt' ? 'abgeschlossen' : 'abgelehnt', b.outcome);
      await this.audit.write(c, actor, { action: `betroffenenantrag_${b.result}`, objectType: 'betroffenenantrag', objectId: id, centerId: r.center_id, reason: b.outcome, requestId: requestIdOf(req) });
      return { status: b.result };
    });
  }
}
