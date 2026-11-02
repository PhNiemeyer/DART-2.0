# Offene Fachfragen und Entscheidungen

Stand 02.11.2026. Der Prototyp **entscheidet keine** dieser Fragen; er macht sie sichtbar und technisch konfigurierbar.
Verantwortlichkeiten nach Lastenheft Kap. 27.

| Nr. | Offene Entscheidung | Verantwortlich | Spätestens | Stand im Prototyp |
|---|---|---|---|---|
| E-01 | Finale Frage-/Modus-/Registermatrix inkl. Patienteninstrumente; vollständige Basic/Science-Matrix der Patientenbögen | Medizinische Registerleitung | vor Inhaltsfreigabe Pilot-MVP | Zuordnungsmatrix V1 = **Vorschlag** (`packages/domain/src/catalog.ts`). Alle Bögen sind Demonstrationsinhalte. |
| E-02 | Erhalten Basic-Fälle ärztliche Zusatzmodule (Quelle: Zusatzbögen = Science) oder nur Science? | Registerleitung | vor Pilot | Matrix V1 bietet Module in beiden Modi an (Masterprompt: „Basis und alle zutreffenden Zusatzmodule“). Widerspruch zur Quellenzuordnung offen. |
| E-03 | Signatur- und Identitätsniveau (QES? Videoident? vor Ort?), neue Informationsfassung | Recht/Datenschutz, Studienleitung | vor produktivem Consent | Demo-Signaturadapter + Zugangscode; Produktion verweigert. |
| E-04 | Zentrales Identitätsmodell und bestehende lokale Pseudonymisierung | Verantwortlicher und Zentren | vor Architekturfreigabe für echte Daten | Pseudonym je Patient und Zentrum; keine zentrumsübergreifende Verknüpfung. |
| E-05 | Geburtsdatum erforderlich? | Registerleitung, Datenschutz | vor Pilot | optionales Feld im Vault mit Hinweis; nicht im Forschungskern. |
| E-06 | Reminderzeiten 7/12 Tage, Arzt +3 Tage, Zeitfenster und Nachholregeln | Registerleitung | vor echtem Versand | Planversion FU-PLAN-KNIE V1 (Status „vorschlag“), Fenster −14/+60 Tage; 120 Monate optional. |
| E-07 | Umgang mit Daten nach Widerruf (Löschung, Einschränkung, Anonymisierung), gesetzliche Ausnahmen | Recht/Datenschutz | vor Pilot | Widerruf sperrt sofort; `withdrawal_event.data_handling = offen_rechtliche_entscheidung`. |
| E-08 | Hosting, Dienstleister, Verträge, SLO, Aufbewahrungsfristen, Drittlandzugriffe | Verantwortlicher mit Betrieb/Datenschutz | vor Pilot | EU/EWR als Voreinstellung dokumentiert; Fristenmatrix als Vorlage (`docs/datenschutz.md`). |
| E-09 | Scorefassungen, Lizenzen, Vergleichbarkeitsregeln (KOOS, EQ-5D, Marx, IKDC, Oxford …) | Wissenschaftliche Leitung | vor produktiver Berechnung/Export | Nur „Demonstrationsscore (kein validiertes Instrument)“. |
| E-10 | Farbpalette und Original-Logo-Verwendung | Auftraggeber/Markenverantwortliche | vor UI-Freigabe | Entwurfstokens aus dem Lastenheft; Original-Logo nicht geliefert und nicht verwendet. |
| E-11 | Mapping aller B-Fälle (668) und Umgang mit C-Werten (20); 33 Neuanlage-Vorschläge | Datenmanagement mit Fachverantwortlichen | vor Migrationsfreigabe | Quellen Q02/Q03 nicht geliefert; synthetisches Mapping demonstriert Verfahren und Klärungsliste. |
| E-12 | Vollständige Datenlieferung aller Register/Gelenke inkl. KnorpelRegister-/DEKOR-Bestände und Nutzungsrechte | Registerleitung/Bestandsbetreiber | vor verbindlicher Migrationsplanung | Quellenmanifest meldet 10 von 12 Quellen als fehlend. |
| E-13 | Verbindliche OPS-Version und Zuordnung OPS → Eingriffskonzept → Modul | Registerleitung | vor Pilot | Beispielkatalog „OPS-BEISPIEL-2026“ auf vereinfachter Kodierebene, ausdrücklich ungeprüft. |
| E-14 | Wer darf Papiernachweise prüfen (Vier-Augen-Prinzip?) und Forschungsexporte genehmigen? | Studienleitung, Datenschutz | vor Pilot | Prüfung durch Arzt/Zentrumsverantwortliche; Exportgenehmigung durch zentrale Administration ≠ Antragsteller. |
| E-15 | Kleingruppenschwelle für Berichte/Exporte | Wissenschaftliche Leitung, Datenschutz | vor erstem Export | Schwelle 5 (Vorschlag), im Export-Manifest ausgewiesen. |
| E-16 | Klärungsliste aus dem Lastenheft: IK_ACTION3/IK_ACTION3_NEU, Datumsvermerk 24.04.3023, FU_ERNEUTOP_YN vs. FU_ERNEUTOP, IK_P_D/IK_USER/IK_VISIT_PLAN im FZ-Blatt, CORRECTED RANGES | Datenmanagement | vor Migrationsfreigabe | Mechanismen vorhanden (unplausibles Datum, ungemappte Spalte, Alias); konkrete Werte erst mit Q03. |

Hinweis: Technische Entscheidungen sind in `docs/adr/` dokumentiert. Sie sind die vorgeschlagene Umsetzungslinie, keine
nachträglich behaupteten früheren Nutzerentscheidungen.
