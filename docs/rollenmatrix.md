# Rollenmatrix

Quelle der Wahrheit im Code: `packages/domain/src/catalog.ts` (`ROLE_PERMISSIONS`). Zusätzlich RLS in der Datenbank (ADR-0003).

| Berechtigung | Zentrale Admin | Zentrumsverantw. | Arzt/Ärztin | Dokumentation | Datenmanagement | Formularredaktion | Formularfreigabe | Forschung | Technik |
|---|---|---|---|---|---|---|---|---|---|
| Fälle lesen (eigenes Zentrum) | – | ✓ | ✓ | ✓ | ✓ (pseudonym) | – | – | – | – |
| Fälle anlegen/bearbeiten | – | ✓ | ✓ | ✓ | – | – | – | – | – |
| Arztangaben abschließen/wiederöffnen | – | – | ✓ | – | – | – | – | – | – |
| Identität lesen (Vault) | – | ✓ | ✓ | ✓ | – | – | – | – | – |
| Identität anlegen | – | – | ✓ | ✓ | – | – | – | – | – |
| Einwilligung vorbereiten/Upload/Widerruf erfassen | – | – | ✓ | ✓ | – | – | – | – | – |
| Nachweis prüfen (Sichtprüfung) | – | ✓ | ✓ | – | – | – | – | – | – |
| Formulare lesen | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | – |
| Formularentwurf bearbeiten | – | – | – | – | – | ✓ | – | – | – |
| Formular freigeben/veröffentlichen (≠ Autor) | – | – | – | – | – | – | ✓ | – | – |
| Zentrumsbericht | – | ✓ | ✓ | – | ✓ | – | – | – | – |
| Export beantragen | – | – | – | – | ✓ | – | – | ✓ | – |
| Export genehmigen (≠ Antragsteller) | ✓ | – | – | – | – | – | – | – | – |
| Migration | – | – | – | – | ✓ | – | – | – | – |
| Zentren/Konten/Rollen | ✓ | – | – | – | – | – | – | – | – |
| Audit lesen | ✓ | – | – | – | – | – | – | – | – |
| Versand-Leitstand bearbeiten (eigenes Zentrum) | – | ✓ | – | ✓ | – | – | – | – | – |
| Versandübersicht aller Zentren (nur Anzahlen) | ✓ | – | – | – | – | – | – | – | – |

Patientinnen und Patienten haben eine eigene, kurzlebige Portalsitzung (Einladungstoken + Zugangscode) und sehen ausschließlich
eigene Einwilligungen und eigene freigegebene Befragungen (restriktive RLS-Policies).

Grenzen: Zentrumsverantwortliche können Änderungen derzeit nicht im System *beantragen* (Antragsworkflow, Restliste R-08);
zeitlich begrenzte Sonderzugriffe (Break-Glass) fehlen (R-07).
