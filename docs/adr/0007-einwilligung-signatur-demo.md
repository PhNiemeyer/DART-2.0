# ADR-0007: Einwilligung – Zustandsautomat, Demo-Signaturadapter, Papierweg

Status: angenommen (Prototyp) · Datum: 02.11.2026

- Zustände: fehlt, vorbereitet, Signatur ausstehend, Upload in Prüfung, gültig, abgelehnt, widerrufen, erneute Einwilligung erforderlich,
  historisch ungeklärt; Übergänge serverseitig erzwungen (`packages/domain/src/consent.ts`). Ein DB-Constraint verhindert „gültig“
  ohne Nachweis, Hash, Prüfzeit und Unterschriftsdatum.
- **Digitaler Weg:** persönliche Vor-Ort-Einladung (einmaliger Token, nur Hash gespeichert, 2 h) + persönlicher Zugangscode (Vault).
  Aktive Zustimmung je Umfang, nichts vorausgewählt. Gezeichnete Unterschrift (nur Bild, keine Dynamikdaten) **oder** getippter Name
  (barrierefreie Alternative). Der austauschbare `SignatureAdapter` ist im Prototyp ein **Demonstrationsadapter** – keine QES und keine
  fortgeschrittene Signatur; in Produktion verweigert. Beweispaket (Informationstext, Version, Hash, Umfang, Verfahren, Zeitpunkt,
  Prüfergebnis) liegt verschlüsselt im Vault; der Kern speichert nur Status, Umfang, Hash und ein Paket ohne Identitätsdaten.
- **Papierweg:** Upload (PDF/JPEG/PNG ≤ 20 MB, Magic-Byte-Prüfung, Malwareprüfung per Adapter) → „Upload in Prüfung“ → Sichtprüfung mit
  vier Prüfpunkten durch berechtigtes Personal → gültig oder abgelehnt mit Grund. Unterschriftsdatum, Uploadzeit und Prüfzeit getrennt.
- **Widerruf:** sperrt sofort Befragungen, Tokens, Sitzungen und geplanten Versand; der Umgang mit vorhandenen Daten ist eine offene Rechtsentscheidung (E-07).
- Der Malware-Adapter erkennt im Prototyp die EICAR-Testsignatur; ohne produktiven Scanner (z. B. ClamAV) wird der Produktionsstart verweigert.
