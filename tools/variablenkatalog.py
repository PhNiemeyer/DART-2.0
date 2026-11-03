"""Variablenkatalog aus den Originalquellen (Q02, Q03) erzeugen und prüfen.

    pnpm katalog              (= python3 -I tools/variablenkatalog.py docs/quellen)
    Voraussetzung: pip install -r tools/requirements.txt   (openpyxl)

- prüft SHA-256 von V05 gegen den im Lastenheft genannten Wert,
- liest alle Katalogzeilen (Blatt „Variablen“) und die Neuanlage-Vorschläge,
- gleicht jede Katalogzeile mit ihrer Quellzeile in V05 ab (Blatt, Zeile, Altname, VARID),
- berechnet Prüfhinweise (Alias, fehlende/mehrfache VARID) unabhängig aus V05 neu,
- schreibt migrations/mapping/katalog-knie-v05.json und docs/quellenanalyse.md.

Es werden KEINE Fachentscheidungen oder Freigaben erzeugt: „Entscheidung“ und „Freigabe durch“
werden unverändert übernommen. Exit-Code 1 bei Abweichungen gegenüber dem Lastenheft.
"""
import hashlib
import json
import os
import sys
import warnings
from collections import Counter

import openpyxl

warnings.filterwarnings("ignore")  # Druckbereich-Warnungen der Quelldatei

DIR = sys.argv[1] if len(sys.argv) > 1 else "docs/quellen"
KLASSIFIKATION = os.path.join(DIR, "DART_2_Variablenklassifikation.xlsx")
V05 = os.path.join(DIR, "PROD_DatabaseDescriptionPlan_DART_Knie_V05.xlsx")
V05_SHA = "23b554addc046957c7f665e5e31a7c9f8bbb627124f30d1c8ad943de6789cb9b"
NON_VARIABLE_SHEETS = ["CRF page types", "Version history", "ddpjson"]
KLASSE_CODE = {"Übernahme": "A", "Überarbeitung": "B", "Entfall": "C"}


def sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def text(v):
    if v is None:
        return ""
    if hasattr(v, "isoformat"):
        return v.isoformat()[:10]
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).replace("\r", "")


def rows(ws):
    return [[text(c) for c in r] for r in ws.iter_rows(values_only=True)]


def main():
    sha_k, sha_v = sha256(KLASSIFIKATION), sha256(V05)
    k = openpyxl.load_workbook(KLASSIFIKATION, read_only=True, data_only=True)
    v = openpyxl.load_workbook(V05, read_only=True, data_only=True)

    var_rows = rows(k["Variablen"])
    h = var_rows[0]

    def col(r, name):
        if name not in h:
            raise SystemExit(f"Spalte „{name}“ fehlt im Blatt Variablen")
        i = h.index(name)
        return (r[i] if i < len(r) else "").strip()

    data = [r for r in var_rows[1:] if any(c.strip() for c in r)]
    entries = []
    for r in data:
        klasse = col(r, "Klasse")
        entries.append({
            "sheet": col(r, "Blatt"),
            "sourceRow": int(col(r, "Quellzeile")),
            "altName": col(r, "Altname"),
            "sasAlias": col(r, "SAS-Alias") or None,
            "varId": col(r, "VARID") or None,
            "dartId": col(r, "DARTID") or None,
            "klasse": klasse,
            "klasseCode": KLASSE_CODE.get(klasse),
            "label": col(r, "Quellbezeichnung"),
            "begruendung": col(r, "Begründung"),
            "zielstruktur": col(r, "Zielstruktur"),
            "migrationsregel": col(r, "Migrationsregel"),
            "vergleichbarkeit": col(r, "Vergleichbarkeit"),
            "basicScience": col(r, "Basic/Science"),
            "pruefhinweise": [x.strip() for x in col(r, "Prüfhinweis").split(";") if x.strip()],
            "entscheidung": col(r, "Entscheidung"),
            "freigabeDurch": col(r, "Freigabe durch") or None,
            "altformat": col(r, "Altformat"),
            "einleseformat": col(r, "Einleseformat"),
            "codeliste": col(r, "Codeliste"),
            "korrigierteCodeliste": col(r, "Korrigierte Codeliste"),
            "verzweigung": col(r, "Verzweigung"),
            "quellaenderung": col(r, "Quelländerung"),
        })
    neu_rows = rows(k["Neuanlage"])
    nh = neu_rows[0]
    neuanlage = [
        {(nh[i] or f"Spalte{i + 1}"): (r[i].strip() if i < len(r) else "") for i in range(len(nh)) if nh[i]}
        for r in neu_rows[1:] if any(c.strip() for c in r)
    ]

    sheet_names = v.sheetnames
    variable_sheets = [n for n in sheet_names if n not in NON_VARIABLE_SHEETS]
    v05 = {n: rows(v[n]) for n in sheet_names}

    def cell(r, i):
        return r[i].strip() if 0 <= i < len(r) else ""

    mismatches = []
    for e in entries:
        sh = v05.get(e["sheet"])
        if sh is None:
            mismatches.append(f"{e['sheet']}:{e['sourceRow']} – Blatt fehlt in V05")
            continue
        hdr = sh[0]
        src = sh[e["sourceRow"] - 1] if e["sourceRow"] - 1 < len(sh) else []
        name_idx = next((i for i, c in enumerate(hdr) if c.startswith("VARNAME") and "SAS" not in c), -1)
        id_idx = hdr.index("VARID") if "VARID" in hdr else -1
        name, vid = cell(src, name_idx), cell(src, id_idx)
        if name != e["altName"] or vid != (e["varId"] or ""):
            mismatches.append(f"{e['sheet']}:{e['sourceRow']} Katalog {e['altName']}/{e['varId'] or '–'} ≠ V05 {name}/{vid or '–'}")

    # Unabhängige Neuberechnung über die referenzierten Quellzeilen
    alias_diff = no_varid = 0
    dup_rows = 0
    for n in variable_sheets:
        sh = v05[n]
        hdr = sh[0]
        # Namensspalte heißt je Blatt „VARNAME eCRF“ oder „VARNAME“ (z. B. DM)
        e_i = next((i for i, c in enumerate(hdr) if c.startswith("VARNAME") and "SAS" not in c), -1)
        s_i = hdr.index("VARNAME SAS") if "VARNAME SAS" in hdr else -1
        id_i = hdr.index("VARID") if "VARID" in hdr else -1
        ref = [sh[x["sourceRow"] - 1] for x in entries if x["sheet"] == n]
        ids = Counter()
        for r in ref:
            if e_i >= 0 and s_i >= 0 and cell(r, s_i) and cell(r, e_i) != cell(r, s_i):
                alias_diff += 1
            vid = cell(r, id_i)
            if not vid:
                no_varid += 1
            else:
                ids[vid] += 1
        dup_rows += sum(c for c in ids.values() if c > 1)

    by_class = Counter(e["klasse"] for e in entries)
    hints = Counter(p for e in entries for p in e["pruefhinweise"])
    by_sheet = Counter(e["sheet"] for e in entries)
    with_approval = sum(1 for e in entries if e["freigabeDurch"])

    checks = [
        ("SHA-256 V05", V05_SHA, sha_v),
        ("Katalogzeilen (Blatt Variablen)", 1441, len(entries)),
        ("Übernahme", 753, by_class["Übernahme"]),
        ("Überarbeitung", 668, by_class["Überarbeitung"]),
        ("Entfall", 20, by_class["Entfall"]),
        ("Neuanlage-Vorschläge", 33, len(neuanlage)),
        ("Zeilen mit eingetragener Freigabeperson", 0, with_approval),
        ("V05 Blätter", 24, len(sheet_names)),
        ("V05 Variablenblätter", 21, len(variable_sheets)),
        ("Hinweis „eCRF-/SAS-Alias abweichend“ (Katalog)", 285, hints["eCRF-/SAS-Alias abweichend"]),
        ("Alias abweichend (aus V05 neu berechnet)", 285, alias_diff),
        ("Hinweis „VARID fehlt“ (Katalog)", 34, hints["VARID fehlt"]),
        ("VARID fehlt (aus V05 neu berechnet)", 34, no_varid),
        ("Hinweis „VARID im Blatt mehrfach“ (Katalog)", 10, hints["VARID im Blatt mehrfach"]),
        ("VARID mehrfach (aus V05 neu berechnet, Zeilen)", 10, dup_rows),
        ("Hinweis „Leere Checkbox nicht automatisch 0“", 355, hints["Leere Checkbox nicht automatisch 0"]),
        ("Katalogzeilen ohne passende V05-Quellzeile", 0, len(mismatches)),
    ]

    os.makedirs("migrations/mapping", exist_ok=True)
    with open("migrations/mapping/katalog-knie-v05.json", "w", encoding="utf-8") as f:
        json.dump({
            "format": "DART-Variablenkatalog",
            "formatVersion": 1,
            "quelle": {
                "klassifikation": {"datei": os.path.basename(KLASSIFIKATION), "sha256": sha_k},
                "datenbankbeschreibung": {"datei": os.path.basename(V05), "sha256": sha_v},
            },
            "hinweis": "Alle Entscheidungen sind Vorschläge ohne Freigabe. Erzeugt durch tools/variablenkatalog.py – nicht von Hand bearbeiten.",
            "eintraege": entries,
            "neuanlage": neuanlage,
        }, f, ensure_ascii=False, indent=1)
        f.write("\n")

    def short(x):
        x = str(x)
        return f"`{x[:12]}…`" if len(x) > 20 else x

    lines = [
        "# Quellenanalyse Variablenkatalog Knie (Q02, Q03)",
        "",
        "Erzeugt durch `pnpm katalog` (`tools/variablenkatalog.py`) aus den Originaldateien in `docs/quellen/`.",
        "Die Analyse prüft Struktur und Kennzahlen. Sie trifft **keine** fachliche Entscheidung und erteilt **keine** Freigabe.",
        "",
        "| Datei | SHA-256 |", "|---|---|",
        f"| {os.path.basename(KLASSIFIKATION)} | `{sha_k}` |",
        f"| {os.path.basename(V05)} | `{sha_v}` |",
        "",
        "## Abgleich mit dem Lastenheft",
        "",
        "| Prüfung | Lastenheft | Gezählt | Ergebnis |", "|---|---|---|---|",
    ]
    for n, exp, act in checks:
        lines.append(f"| {n} | {short(exp)} | {short(act)} | {'stimmt' if str(exp) == str(act) else '**ABWEICHUNG**'} |")
    hint_rows = sum(1 for e in entries if e["pruefhinweise"])
    multi = sum(1 for e in entries if len(e["pruefhinweise"]) > 1)
    decisions = Counter(e["entscheidung"] for e in entries)
    lines += [
        "",
        f"Zeilen mit mindestens einem Prüfhinweis: {hint_rows}; davon mit mehreren Hinweisen: {multi} "
        "(Hinweise überlagern sich, die Zählwerte sind nicht addierbar).",
        "Entscheidungsstatus: " + ", ".join(f"„{k2}“ {n}" for k2, n in decisions.items()) + ".",
        "",
        "## Katalogzeilen je Blatt", "",
        "| Blatt | Zeilen | Übernahme | Überarbeitung | Entfall |", "|---|---|---|---|---|",
    ]
    for s in by_sheet:
        es = [x for x in entries if x["sheet"] == s]
        lines.append(f"| {s} | {len(es)} | {sum(x['klasseCode'] == 'A' for x in es)} | {sum(x['klasseCode'] == 'B' for x in es)} | {sum(x['klasseCode'] == 'C' for x in es)} |")
    lines += ["", "## Basic/Science-Zuordnung laut Katalog", ""]
    lines += [f"- {k2}: {n}" for k2, n in Counter(e["basicScience"] for e in entries).most_common()]
    lines += ["", "## Prüfhinweise", "", "| Hinweis | Zeilen |", "|---|---|"]
    lines += [f"| {k2} | {n} |" for k2, n in hints.most_common()]
    lines += ["", "## Abweichungen Katalog ↔ V05", ""]
    lines += [f"- {m}" for m in mismatches] or ["Keine: alle Katalogzeilen verweisen auf die passende Quellzeile (Blatt, Zeile, Altname, VARID)."]
    lines += ["", "## V05-Blätter", ""]
    for n in sheet_names:
        if n in NON_VARIABLE_SHEETS:
            lines.append(f"- {n} (kein Variablenblatt)")
        else:
            nonempty = sum(1 for r in v05[n][1:] if any(c.strip() for c in r))
            lines.append(f"- {n} – {nonempty} nicht leere Datenzeilen, davon {by_sheet.get(n, 0)} im Katalog")
    with open("docs/quellenanalyse.md", "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    print("\n".join(lines[:len(checks) + 14]))
    failed = [c for c in checks if str(c[1]) != str(c[2])]
    if failed:
        print(f"{len(failed)} Abweichung(en) gegenüber dem Lastenheft", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
