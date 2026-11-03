import { createHash } from 'node:crypto';
import { ASSIGNMENT_MATRIX_V1, FOLLOWUP_PLAN_V1 } from '@dart/domain';
import { canonicalJson, DEMO_SCORE_V1, validateSchema } from '@dart/forms';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { buildIkdcForm, buildKoosForm } from './instruments';
import { DEMO_CONSENT_BODY, DEMO_FORMS } from './seed-forms';

/**
 * Basis-Seed (idempotent): Zentren, Demo-Nutzer, Einwilligungsdokument, veröffentlichte Demonstrationsbögen,
 * Planversionen, Quellenmanifest. AUSSCHLIESSLICH synthetische Daten. Läuft als Migrationsrolle (dart_owner).
 */
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export const DEMO_USERS: Array<{ username: string; name: string; roles: Array<[string, string | null]> }> = [
  { username: 'admin', name: 'Zentrale Administration (Demo)', roles: [['zentrale_admin', null]] },
  { username: 'dr.nord', name: 'Dr. Beispiel Nord', roles: [['arzt', 'Z-101']] },
  { username: 'dr.nord2', name: 'Dr. Muster Nord', roles: [['arzt', 'Z-101']] },
  { username: 'doku.nord', name: 'Dokumentation Nord (Demo)', roles: [['dokumentation', 'Z-101']] },
  { username: 'leitung.nord', name: 'Zentrumsleitung Nord (Demo)', roles: [['zentrumsverantwortlich', 'Z-101']] },
  { username: 'dr.sued', name: 'Dr. Beispiel Süd', roles: [['arzt', 'Z-102']] },
  { username: 'daten', name: 'Datenmanagement (Demo)', roles: [['datenmanagement', null], ['datenmanagement', 'Z-101'], ['datenmanagement', 'Z-102']] },
  { username: 'redaktion', name: 'Formularredaktion (Demo)', roles: [['formularredaktion', null]] },
  { username: 'freigabe', name: 'Formularfreigabe (Demo)', roles: [['formularfreigabe', null]] },
  { username: 'forschung', name: 'Forschung (Demo)', roles: [['forschung', null]] },
  { username: 'technik', name: 'Technischer Betrieb (Demo)', roles: [['technik', null]] },
];

/** Quellen laut Lastenheft; im Arbeitsverzeichnis nicht vorhanden → als fehlend gemeldet. */
export const SOURCE_MANIFEST: Array<{ code: string; file: string; expected?: string; actual?: string; note: string }> = [
  { code: 'Q02', file: 'DART_2_Variablenklassifikation.xlsx', actual: '0a333a5632762ceda5c355bfda62402fc506a9e57fec49147a4cd0e9a9ed0778', note: 'Geliefert 03.11.2026; 1.441 Katalogzeilen und 33 Neuanlage-Vorschläge nachgezählt (docs/quellenanalyse.md)' },
  { code: 'Q03', file: 'PROD_DatabaseDescriptionPlan_DART_Knie_V05.xlsx', expected: '23b554addc046957c7f665e5e31a7c9f8bbb627124f30d1c8ad943de6789cb9b', actual: '23b554addc046957c7f665e5e31a7c9f8bbb627124f30d1c8ad943de6789cb9b', note: 'Geliefert 03.11.2026; SHA-256 stimmt mit dem Lastenheft überein' },
  { code: 'Q04', file: 'ePIC_DART_V01_final_20170912.docx', note: 'Nicht geliefert' },
  { code: 'Q05', file: 'Datenschutzkonzept_DART_V01_20170922.pdf', note: 'Nicht geliefert' },
  { code: 'Q06', file: 'DEKOR Arztbogen Basisfragen.pdf', note: 'Nicht geliefert; DEKOR-Beispiel im Prototyp ist eine eigene Demonstration' },
  { code: 'Q07', file: 'DEKOR Arztbogen Osteotomie.pdf', note: 'Nicht geliefert' },
  { code: 'Q08', file: 'DART_Knie_Uebersichtsreport_20250114.pdf', note: 'Nicht geliefert' },
  { code: 'Q09', file: 'DART_Logo_CMYK.pdf / DART_Logo_CMYK.jpg', note: 'Nicht geliefert; das Original-Logo wird in der Anwendung daher nicht verwendet (Textmarke „DART 2.0“)' },
  { code: 'Q11', file: 'DART_Studienplan_V2.1_20211122_final.pdf', note: 'Nicht geliefert (öffentlich verlinkt laut Lastenheft)' },
  { code: 'Q12', file: 'DART_Datenschutzkonzept_V02_20201207_final.pdf', note: 'Nicht geliefert (öffentlich verlinkt laut Lastenheft)' },
  { code: 'Q-SCR', file: 'Fünf ältere Anwendungsscreenshots', note: 'Waren bereits bei Erstellung des Lastenhefts nicht als Dateien zugänglich' },
  { code: 'Q-LH', file: 'DART_2_0_Lastenheft.pdf', note: 'Geliefert (Fassung 1.0, 02.11.2026)' },
  { code: 'Q-MP', file: 'DART_2_0_Claude_Code_Masterprompt.md', note: 'Geliefert' },
];

/** Variablenkatalog V05 laden (idempotent: je Quell-Hash genau einmal, ältere Fassung wird ersetzt). */
function catalogFile(): string | undefined {
  return [join(__dirname, '../../../migrations/mapping/katalog-knie-v05.json'), join(process.cwd(), 'migrations/mapping/katalog-knie-v05.json')].find((f) => existsSync(f));
}

/** IKDC/KOOS aus dem Katalog V05 (Scoring Freigabe ausstehend). */
function instrumentForms() {
  const file = catalogFile();
  if (!file) return [];
  const cat = JSON.parse(readFileSync(file, 'utf8')).eintraege;
  return [buildIkdcForm(cat), buildKoosForm(cat)];
}

async function seedCatalog(c: Client) {
  const file = catalogFile();
  if (!file) {
    console.log('[seed] Variablenkatalog nicht gefunden – übersprungen');
    return;
  }
  const cat = JSON.parse(readFileSync(file, 'utf8'));
  const code = 'KNIE-V05';
  const sha = cat.quelle.datenbankbeschreibung.sha256 + ':' + cat.quelle.klassifikation.sha256;
  const cur = await c.query('SELECT count(*)::int AS n, min(source_sha256) AS sha FROM legacy.catalog_entry WHERE catalog_code = $1', [code]);
  if (cur.rows[0].n === cat.eintraege.length && cur.rows[0].sha === sha) return;
  await c.query('DELETE FROM legacy.catalog_entry WHERE catalog_code = $1', [code]);
  await c.query('DELETE FROM legacy.catalog_neuanlage WHERE catalog_code = $1', [code]);
  for (const e of cat.eintraege) {
    await c.query(
      `INSERT INTO legacy.catalog_entry (catalog_code, source_sha256, sheet, source_row, alt_name, sas_alias, var_id, dart_id, klasse, klasse_code, label, basic_science, vergleichbarkeit, pruefhinweise, entscheidung, freigabe_durch, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [code, sha, e.sheet, e.sourceRow, e.altName, e.sasAlias, e.varId, e.dartId, e.klasse, e.klasseCode, e.label, e.basicScience, e.vergleichbarkeit, e.pruefhinweise, e.entscheidung, e.freigabeDurch, JSON.stringify(e)],
    );
  }
  let i = 0;
  for (const n of cat.neuanlage) await c.query('INSERT INTO legacy.catalog_neuanlage (catalog_code, position, zielstruktur, details) VALUES ($1,$2,$3,$4)', [code, ++i, n['Zielvariable / Struktur'], JSON.stringify(n)]);
  console.log(`[seed] Variablenkatalog ${code}: ${cat.eintraege.length} Einträge, ${cat.neuanlage.length} Neuanlage-Vorschläge`);
}

export async function seedBase(url: string): Promise<void> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    const centers: Record<string, string> = {};
    for (const [code, name] of [['Z-101', 'Demo-Zentrum Nord (synthetisch)'], ['Z-102', 'Demo-Zentrum Süd (synthetisch)']]) {
      const r = await c.query('INSERT INTO center (code, name) VALUES ($1,$2) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id', [code, name]);
      centers[code] = r.rows[0].id;
    }
    const hasApproval = await c.query('SELECT 1 FROM center_science_approval WHERE center_id = $1', [centers['Z-101']]);
    if (!hasApproval.rows.length) {
      await c.query(`INSERT INTO center_science_approval (center_id, valid_from, approved_by, reference) VALUES ($1, '2026-01-01', 'Studienleitung (Demo)', 'DEMO-FREIGABE-001')`, [centers['Z-101']]);
    }
    for (const u of DEMO_USERS) {
      const r = await c.query('INSERT INTO app_user (username, display_name, is_demo) VALUES ($1,$2,true) ON CONFLICT (username) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING id', [u.username, u.name]);
      for (const [role, center] of u.roles) {
        await c.query('INSERT INTO user_center_role (user_id, center_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [r.rows[0].id, center ? centers[center] : null, role]);
      }
    }
    const scopes = ['register_basic', 'science', 'knorpelregister', 'dekor', 'kontakt_followup'];
    await c.query(
      `INSERT INTO consent_document_version (code, version, title, body, body_sha256, scopes, is_demo) VALUES ('DART-EW', 'Demo 1.0', $1, $2, $3, $4, true) ON CONFLICT (code, version) DO NOTHING`,
      ['Patienteninformation und Einwilligung (Demonstration)', DEMO_CONSENT_BODY, sha(DEMO_CONSENT_BODY), scopes],
    );
    const admin = (await c.query(`SELECT id FROM app_user WHERE username = 'redaktion'`)).rows[0].id;
    const approver = (await c.query(`SELECT id FROM app_user WHERE username = 'freigabe'`)).rows[0].id;
    const instruments = instrumentForms();
    for (const f of [...DEMO_FORMS, ...instruments]) {
      const errs = validateSchema(f);
      if (errs.length) throw new Error(`Seed-Formular ${f.code} ungültig: ${errs.map((e) => e.message).join('; ')}`);
      const q = await c.query('INSERT INTO questionnaire (code, title, audience, module_code) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO UPDATE SET title = EXCLUDED.title RETURNING id', [f.code, f.title, f.audience, f.module]);
      const exists = await c.query('SELECT 1 FROM questionnaire_version WHERE questionnaire_id = $1', [q.rows[0].id]);
      if (exists.rows.length) continue;
      await c.query(
        `INSERT INTO questionnaire_version (questionnaire_id, version, status, schema, schema_hash, author_id, submitted_at, approved_by, approved_at, published_by, published_at, valid_from, change_note)
         VALUES ($1, 1, 'veroeffentlicht', $2, $3, $4, now(), $5, now(), $5, now(), '2026-01-01', $6)`,
        [q.rows[0].id, JSON.stringify(f), sha(canonicalJson(f)), admin, approver, instruments.includes(f) ? 'Aus V05 (Blätter IK/KO) abgeleitet; wissenschaftliche Freigabe und Lizenzklärung ausstehend (E-09); Seed' : 'Demonstrationsversion (Seed)'],
      );
    }
    await c.query(
      `INSERT INTO score_algorithm_version (code, version, name, definition) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [DEMO_SCORE_V1.code, DEMO_SCORE_V1.version, DEMO_SCORE_V1.name, JSON.stringify({ ...DEMO_SCORE_V1, compute: undefined })],
    );
    await c.query(`INSERT INTO followup_plan_version (code, version, status, definition) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [FOLLOWUP_PLAN_V1.code, FOLLOWUP_PLAN_V1.version, FOLLOWUP_PLAN_V1.status, JSON.stringify(FOLLOWUP_PLAN_V1)]);
    await c.query(`INSERT INTO assignment_matrix_version (code, version, status, valid_from, definition) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [ASSIGNMENT_MATRIX_V1.code, ASSIGNMENT_MATRIX_V1.version, ASSIGNMENT_MATRIX_V1.status, ASSIGNMENT_MATRIX_V1.validFrom, JSON.stringify(ASSIGNMENT_MATRIX_V1)]);
    for (const s of SOURCE_MANIFEST) {
      const status = ['Q-LH', 'Q-MP', 'Q02', 'Q03'].includes(s.code) ? 'vorhanden' : 'fehlt';
      await c.query(
        `INSERT INTO legacy.source_manifest (source_code, file_name, expected_sha256, actual_sha256, status, note) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (source_code, file_name) DO UPDATE SET actual_sha256 = EXCLUDED.actual_sha256, status = EXCLUDED.status, note = EXCLUDED.note`,
        [s.code, s.file, s.expected ?? null, s.actual ?? null, status, s.note],
      );
    }
    await seedCatalog(c);
    await c.query('COMMIT');
    console.log('[seed] Basisdaten aktuell (synthetisch)');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}

if (require.main === module) {
  const url = process.env.SEED_DATABASE_URL ?? process.env.CORE_MIGRATION_URL;
  if (!url) {
    console.error('SEED_DATABASE_URL fehlt');
    process.exit(2);
  }
  if (process.env.NODE_ENV === 'production') {
    console.error('Seed mit Demo-Daten in Produktion verweigert');
    process.exit(2);
  }
  seedBase(url).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
