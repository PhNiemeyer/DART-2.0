/**
 * Quelleninventar (M01/M02, T03): prüft Vorhandensein und SHA-256 der im Lastenheft genannten Quellen.
 * Aufruf: pnpm quellen [verzeichnis]   (Standard: ./quellen und ./docs/quellen)
 * Schreibt docs/quellenmanifest.generiert.md. Fehlende Dateien werden gemeldet, nichts wird erfunden.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const EXPECTED: Array<{ code: string; pattern: RegExp; label: string; sha256?: string }> = [
  { code: 'Q02', pattern: /^DART_2_Variablenklassifikation\.xlsx$/i, label: 'Variablenklassifikation (1.441 Katalogzeilen laut Lastenheft)' },
  { code: 'Q03', pattern: /^PROD_DatabaseDescriptionPlan_DART_Knie_V05\.xlsx$/i, label: 'Datenbankbeschreibung Knie V05', sha256: '23b554addc046957c7f665e5e31a7c9f8bbb627124f30d1c8ad943de6789cb9b' },
  { code: 'Q04', pattern: /^ePIC_DART_V01_final_20170912\.docx$/i, label: 'Elektronische Patienteninformation/Einwilligung 12.09.2017' },
  { code: 'Q05', pattern: /^Datenschutzkonzept_DART_V01_20170922\.pdf$/i, label: 'Datenschutzkonzept 22.09.2017' },
  { code: 'Q06', pattern: /^DEKOR Arztbogen Basisfragen\.pdf$/i, label: 'DEKOR Arztbogen Basisfragen' },
  { code: 'Q07', pattern: /^DEKOR Arztbogen Osteotomie\.pdf$/i, label: 'DEKOR Arztbogen Osteotomie' },
  { code: 'Q08', pattern: /^DART_Knie_Uebersichtsreport_20250114\.pdf$/i, label: 'DART-Knie-Übersichtsreport 14.01.2025' },
  { code: 'Q09', pattern: /^DART_Logo_CMYK\.(pdf|jpg|eps)$/i, label: 'Original-Logo (CMYK)' },
  { code: 'Q11', pattern: /^DART_Studienplan_V2\.1_20211122_final\.pdf$/i, label: 'Studienplan 2.1 (2021)' },
  { code: 'Q12', pattern: /^DART_Datenschutzkonzept_V02_20201207_final\.pdf$/i, label: 'Datenschutzkonzept 2 (2020)' },
  { code: 'Q-LH', pattern: /^DART_2_0_Lastenheft\.pdf$/i, label: 'Lastenheft DART 2.0, Fassung 1.0' },
  { code: 'Q-MP', pattern: /^DART_2_0_Claude_Code_Masterprompt\.md$/i, label: 'Coding-Masterprompt' },
];

const dirs = process.argv.slice(2).length ? process.argv.slice(2) : ['quellen', 'docs/quellen'];
const files: Array<{ name: string; path: string }> = [];
for (const d of dirs) if (existsSync(d)) for (const f of readdirSync(d)) if (statSync(join(d, f)).isFile()) files.push({ name: f, path: join(d, f) });

const rows: string[] = [];
let missing = 0;
for (const e of EXPECTED) {
  const hits = files.filter((f) => e.pattern.test(f.name));
  if (!hits.length) {
    missing++;
    rows.push(`| ${e.code} | ${e.label} | fehlt | – | ${e.sha256 ? `erwartet ${e.sha256.slice(0, 16)}…` : ''} |`);
    continue;
  }
  for (const h of hits) {
    const sha = createHash('sha256').update(readFileSync(h.path)).digest('hex');
    const status = e.sha256 ? (sha === e.sha256 ? 'vorhanden, Hash stimmt' : 'ABWEICHENDE VERSION – als neue Quellenversion behandeln') : 'vorhanden';
    rows.push(`| ${e.code} | ${h.name} | ${status} | \`${sha}\` | ${statSync(h.path).size} Byte |`);
  }
}
const out = `# Quellenmanifest (generiert)

Erzeugt am ${new Date().toISOString()} durch \`tools/quellen-inventar.ts\`. Durchsuchte Verzeichnisse: ${dirs.join(', ')}.

| Quelle | Datei | Status | SHA-256 | Hinweis |
|---|---|---|---|---|
${rows.join('\n')}

${missing} von ${EXPECTED.length} erwarteten Quellen fehlen. Fehlende Quellen blockieren nur die davon abhängige fachliche Freigabe, nicht die technische Entwicklung.
`;
writeFileSync('docs/quellenmanifest.generiert.md', out);
console.log(out);
