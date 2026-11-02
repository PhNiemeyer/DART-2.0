# Design-Tokens (DART-2.0-Entwurf)

Gestaltungsvorschlag aus dem Lastenheft (Kap. 07). **Kein** bestehender Web-Styleguide; das Original-Logo wird nicht umgefärbt
und – da nicht geliefert – im Prototyp nicht verwendet (Textmarke „DART 2.0“).

| Token | Wert | Zweck |
|---|---|---|
| navy | `#12304A` | Navigation, Titel |
| blue | `#1559B7` | primäre Aktionen, Links |
| teal | `#087F83` | sekundäre Aktionen |
| mint | `#DDF4EC` | ruhige Hintergründe (dunkler Text) |
| green | `#58C99A` | Akzente (dunkler Text; nie alleinige Statusinformation) |
| surface / background | `#FFFFFF` / `#F4F7FA` | Karten / Arbeitsfläche |
| text / muted | `#183247` / `#526575` | Haupt- / Hilfetext |
| border | `#CBD5DF` | Rahmen |
| danger / warning | `#B42318` / `#8A4B08` | Fehler / Warnung |

Umsetzung: CSS-Variablen in `apps/web/app/globals.css`, TypeScript in `packages/ui/src/index.ts`.
Schrift: Inter, selbst gehostet (`@fontsource/inter`), Fallback system-ui; Basis 16 px, Zeilenhöhe 1,5, 8-px-Raster,
Eingabehöhe ≥ 44 px, Radien 10–12 px. Fokus: sichtbarer Doppelring. Status immer mit Text (und Punktsymbol).

## Geprüfte Kontraste (automatisierter Test `packages/ui/src/tokens.test.ts`, WCAG 2.2 AA ≥ 4,5 : 1)

Weiß auf navy, blue, teal · text auf mint, green, surface, background · muted, danger, warning, blue, teal auf surface – alle 12 Paare bestanden.
