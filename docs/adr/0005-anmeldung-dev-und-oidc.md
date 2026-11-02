# ADR-0005: Anmeldung – Keycloak/OIDC und lokaler Demo-Modus

Status: angenommen · Datum: 02.11.2026

## Entscheidung
- `AUTH_MODE=oidc`: Authorization Code Flow mit PKCE und `state` gegen Keycloak (Realm `infra/keycloak/dart-realm.json`).
  Erstanmeldung bindet den Keycloak-Subject an ein **zentral angelegtes** DART-Konto (keine Selbstregistrierung). Danach eigene,
  signierte HttpOnly-Sitzung (SameSite=Strict, 8 h). Bearer-Tokens von Keycloak werden ebenfalls akzeptiert (JWKS-Prüfung).
- `AUTH_MODE=dev`: Demo-Nutzerauswahl nur für lokale Entwicklung; **Produktionsstart wird verweigert** (`config.ts`).
- Rollen und Sperren werden bei jeder Anfrage frisch aus der Datenbank gelesen (sofort wirksam).
- CSRF: Cookie-Sitzungen verlangen den Header `x-dart-csrf: 1` bei schreibenden Anfragen.

## Abweichung / offen
- MFA: Der Realm hat eine TOTP-Richtlinie, erzwingt sie lokal aber nicht (Demo-Komfort). Für den Pilot ist MFA als Pflicht-Aktion im
  Realm zu setzen (Restliste R-02). Die OIDC-Anmeldung wurde im Compose-Stack mit Playwright erfolgreich geprüft (`tests/e2e/oidc.spec.ts`).
