import { MappingEntry, MappingRuleVersion } from './migration';

/** Eintrag des Variablenkatalogs (erzeugt aus Q02/Q03 durch tools/variablenkatalog.py). */
export interface CatalogEntry {
  sheet: string;
  sourceRow: number;
  altName: string;
  sasAlias: string | null;
  varId: string | null;
  dartId: string | null;
  klasse: string;
  klasseCode: 'A' | 'B' | 'C';
  label: string;
  vergleichbarkeit: string;
  basicScience: string;
  pruefhinweise: string[];
  entscheidung: string;
  freigabeDurch: string | null;
  altformat: string;
  codeliste: string;
  [k: string]: unknown;
}

export const V05_SOURCE_SYSTEM = 'DART-KNIE-PROD';
export const V05_EXPORT_VERSION = 'V05';

/**
 * Mappingversion aus dem Katalog – VORSCHLAG ohne Freigabe:
 * - P_ID → technische Beleg-ID (laut Katalog CRF-/Receipt-ID, keine Patientenkennung),
 * - Klasse C (Entfall) → bewusst historisch archiviert (Erhebung entfällt, Werte bleiben),
 * - alle übrigen Variablen → Ziel offen: Rohwert gesichert, ungeklärt, bis eine Fachfreigabe vorliegt.
 * Zuordnung je Blatt über Altname (eCRF) oder SAS-Alias, niemals VARID-only.
 */
export function mappingFromCatalog(entries: CatalogEntry[], version = 1): MappingRuleVersion {
  const mapped: MappingEntry[] = entries.map((e) => {
    const checkbox = e.pruefhinweise.includes('Leere Checkbox nicht automatisch 0');
    const target: MappingEntry['target'] = e.altName === 'P_ID' ? { kind: 'record_id' } : e.klasseCode === 'C' ? { kind: 'archive' } : { kind: 'offen', checkbox };
    return {
      sheet: e.sheet,
      column: e.altName,
      varId: e.varId,
      dartId: e.dartId ?? undefined,
      sasAlias: e.sasAlias && e.sasAlias !== e.altName ? e.sasAlias : undefined,
      classification: e.klasseCode,
      target,
      status: e.freigabeDurch ? 'freigegeben' : 'vorschlag',
    };
  });
  return {
    code: 'MAP-DART-KNIE-V05',
    version,
    status: 'vorschlag',
    sourceSystem: V05_SOURCE_SYSTEM,
    exportVersions: [V05_EXPORT_VERSION],
    // Visitcodes sind in V05 über Formate (z. B. visitf.) beschrieben, aber nicht freigegeben zugeordnet
    visitCodes: {},
    entries: mapped,
  };
}
