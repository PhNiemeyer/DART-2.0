import { FormSchema } from '@dart/forms';

/**
 * DEMONSTRATIONSBÖGEN. Alle Fragen, Codes und Grenzwerte sind Beispiele ohne fachliche Freigabe.
 * Sie bilden keine Originalfragen, keine lizenzierten Instrumente und keine endgültigen Inhalte ab.
 */
const scale = (low: string, high: string) => [
  { code: '0', label: `0 – ${low}` },
  { code: '1', label: '1' },
  { code: '2', label: '2' },
  { code: '3', label: '3' },
  { code: '4', label: `4 – ${high}` },
];

export const DEMO_FORMS: FormSchema[] = [
  {
    schemaVersion: 1,
    code: 'KNIE-BASIC-ARZT',
    title: 'Knie Basic – Arztbogen Basis (Beispiel)',
    audience: 'arzt',
    module: 'BASIS',
    description: 'Basisbogen DART Basic. Nicht identisch mit dem Science-Basisbogen BA.',
    sections: [
      {
        id: 'anamnese',
        title: 'Anamnese (Beispiel)',
        module: 'BASIS',
        items: [
          { id: 'bas_vorop', varId: 'DEMO_BAS_VOROP', label: 'Voroperationen am betroffenen Knie (Beispiel)', type: 'yesno', required: true },
          { id: 'bas_vorop_anzahl', varId: 'DEMO_BAS_VOROP_N', label: 'Anzahl Voroperationen (Beispiel)', type: 'number', min: 1, max: 20, decimals: 0, required: true, visibleIf: { eq: [{ var: 'bas_vorop' }, 'ja'] } },
          { id: 'bas_asa', varId: 'DEMO_BAS_ASA', label: 'Allgemeinzustand, Beispielklassifikation', type: 'single', required: true, codes: [{ code: '1', label: 'Klasse 1 (Beispiel)' }, { code: '2', label: 'Klasse 2 (Beispiel)' }, { code: '3', label: 'Klasse 3 (Beispiel)' }, { code: '4', label: 'Klasse 4 (Beispiel)' }], allowedMissing: ['unbekannt'] },
          { id: 'bas_bmi', varId: 'DEMO_BAS_BMI', label: 'Body-Mass-Index (Beispiel)', type: 'number', unit: 'kg/m²', min: 10, max: 80, decimals: 1, allowedMissing: ['nicht_erhoben'], validations: [{ rule: { lte: [{ var: 'bas_bmi' }, 45] }, message: 'Ungewöhnlich hoher Wert – bitte prüfen (Beispiel-Plausibilitätsregel, kein Grenzwert).', severity: 'hinweis' }] },
          { id: 'bas_befund', varId: 'DEMO_BAS_BEFUND', label: 'Kurzbefund (Freitext, Beispiel)', type: 'text', help: 'Keine Namen oder identifizierenden Angaben eintragen.' },
        ],
      },
    ],
  },
  {
    schemaVersion: 1,
    code: 'KNIE-BA-ARZT',
    title: 'Knie Science – Basisbogen BA (Beispiel)',
    audience: 'arzt',
    module: 'BASIS',
    description: 'Science-Basisbogen BA (Beispielinhalt). Umfangreicher als die Basic-Basis.',
    sections: [
      {
        id: 'anamnese',
        title: 'Anamnese (Beispiel)',
        module: 'BASIS',
        items: [
          { id: 'ba_vorop', varId: 'DEMO_BA_VOROP', label: 'Voroperationen am betroffenen Knie (Beispiel)', type: 'yesno', required: true },
          { id: 'ba_vorop_art', varId: 'DEMO_BA_VOROP_ART', label: 'Art der Voroperation (Beispiel)', type: 'multi', codes: [{ code: 'arthroskopie', label: 'Arthroskopie' }, { code: 'band', label: 'Bandrekonstruktion' }, { code: 'sonstige', label: 'Sonstige' }], required: true, visibleIf: { eq: [{ var: 'ba_vorop' }, 'ja'] } },
          { id: 'ba_beginn', varId: 'DEMO_BA_BEGINN', label: 'Beginn der Beschwerden (Beispiel)', type: 'date', allowedMissing: ['unbekannt'], required: true },
          { id: 'ba_sport', varId: 'DEMO_BA_SPORT', label: 'Sportliche Aktivität vor Beschwerdebeginn (Beispiel)', type: 'single', codes: [{ code: 'keine', label: 'Keine' }, { code: 'freizeit', label: 'Freizeit' }, { code: 'wettkampf', label: 'Wettkampf' }], required: true },
          { id: 'ba_au', varId: 'DEMO_BA_AU', label: 'Arbeitsunfähigkeit zum Zeitpunkt der Behandlung (Beispiel)', type: 'yesno' },
        ],
      },
    ],
  },
  {
    schemaVersion: 1,
    code: 'KNIE-KNORPEL-ARZT',
    title: 'Modul Knorpel – Arztbogen (Beispiel)',
    audience: 'arzt',
    module: 'KNORPEL',
    sections: [
      {
        id: 'defekte',
        title: 'Knorpeldefekte (Beispiel)',
        module: 'KNORPEL',
        items: [
          {
            id: 'defekte',
            varId: 'DEMO_KN_DEFEKTE',
            label: 'Defekte',
            type: 'group',
            repeat: { min: 1, max: 5, instanceLabel: 'Defekt' },
            items: [
              { id: 'def_lok', varId: 'DEMO_KN_LOK', label: 'Lokalisation (Beispielcodes)', type: 'single', required: true, codes: [{ code: 'mfc', label: 'Medialer Femurkondylus' }, { code: 'lfc', label: 'Lateraler Femurkondylus' }, { code: 'troch', label: 'Trochlea' }, { code: 'pat', label: 'Patella' }, { code: 'tib', label: 'Tibiaplateau' }] },
              { id: 'def_groesse', varId: 'DEMO_KN_GROESSE', label: 'Defektgröße (Beispiel)', type: 'number', unit: 'cm²', min: 0, max: 30, decimals: 1, required: true, allowedMissing: ['nicht_erhoben'] },
              { id: 'def_grad', varId: 'DEMO_KN_GRAD', label: 'Schweregrad (Beispielskala)', type: 'single', required: true, codes: [{ code: '1', label: 'Grad 1 (Beispiel)' }, { code: '2', label: 'Grad 2 (Beispiel)' }, { code: '3', label: 'Grad 3 (Beispiel)' }, { code: '4', label: 'Grad 4 (Beispiel)' }] },
              { id: 'def_beh', varId: 'DEMO_KN_BEH', label: 'Behandlung des Defekts (Beispiel)', type: 'multi', required: true, codes: [{ code: 'glaettung', label: 'Glättung' }, { code: 'mikrofrakt', label: 'Knochenmarkstimulation' }, { code: 'zelltx', label: 'Zelltransplantation' }] },
            ],
          },
          { id: 'kn_begleit', varId: 'DEMO_KN_BEGLEIT', label: 'Begleiteingriffe (Beispiel)', type: 'yesno', required: true },
        ],
      },
    ],
  },
  {
    schemaVersion: 1,
    code: 'DEKOR-OSTEOTOMIE-ARZT',
    title: 'DEKOR / Osteotomie – Arztbogen (Beispiel)',
    audience: 'arzt',
    module: 'OSTEOTOMIE',
    description: 'Beispiel für Messwert, Einheit und Messmethode. Medizinische Grenzwerte sind fachlich offen.',
    sections: [
      {
        id: 'messwerte',
        title: 'Messwerte und Untersuchungsmethode',
        module: 'OSTEOTOMIE',
        items: [
          { id: 'dek_methode', varId: 'DEMO_DK_METHODE', label: 'Messmethode (Beispiel)', type: 'single', required: true, codes: [{ code: 'ganzbein', label: 'Ganzbeinstandaufnahme (Beispielmethode)' }, { code: 'ct', label: 'Schnittbild (Beispielmethode)' }] },
          { id: 'dek_winkel', varId: 'DEMO_DK_WINKEL', label: 'Beispielfeld: Winkel', type: 'number', unit: 'Grad', method: 'gemäß gewählter Messmethode', min: 60, max: 120, decimals: 1, required: true },
          { id: 'dek_art', varId: 'DEMO_DK_ART', label: 'Osteotomieart (Beispiel)', type: 'single', required: true, codes: [{ code: 'open', label: 'Öffnend (Beispiel)' }, { code: 'closed', label: 'Schließend (Beispiel)' }] },
          { id: 'dek_platte', varId: 'DEMO_DK_PLATTE', label: 'Implantat (Freitext, Beispiel)', type: 'text', required: true, visibleIf: { eq: [{ var: 'dek_art' }, 'open'] }, help: 'Beispielregel aktiv: erscheint nur bei öffnender Osteotomie.' },
          { id: 'dek_korrektur', varId: 'DEMO_DK_KORR', label: 'Geplante Korrektur (Beispiel)', type: 'number', unit: 'mm', min: 0, max: 30, decimals: 1, required: true },
        ],
      },
    ],
  },
  {
    schemaVersion: 1,
    code: 'KNIE-MENISKUS-ARZT',
    title: 'Modul Meniskus – Arztbogen (Beispiel)',
    audience: 'arzt',
    module: 'MENISKUS',
    sections: [
      {
        id: 'meniskus',
        title: 'Meniskus (Beispiel)',
        module: 'MENISKUS',
        items: [
          { id: 'men_lok', varId: 'DEMO_MN_LOK', label: 'Betroffener Meniskus (Beispiel)', type: 'single', required: true, codes: [{ code: 'medial', label: 'Medial' }, { code: 'lateral', label: 'Lateral' }, { code: 'beide', label: 'Beide' }] },
          { id: 'men_naht', varId: 'DEMO_MN_NAHT', label: 'Naht durchgeführt (Beispiel)', type: 'yesno', required: true },
        ],
      },
    ],
  },
  {
    schemaVersion: 1,
    code: 'KNIE-PAT',
    title: 'Patientenbefragung Knie (Demonstration)',
    audience: 'patient',
    module: 'BASIS',
    description: 'Demonstrationsfragen – kein validiertes Instrument, keine Originalfragen.',
    sections: [
      {
        id: 'alltag',
        title: 'Ihr Knie im Alltag',
        items: [
          { id: 'pq1', varId: 'DEMO_PAT_Q1', label: 'Wie stark beeinträchtigt Ihr Knie Sie beim Gehen? (Demonstrationsfrage)', type: 'single', required: true, codes: scale('sehr stark', 'gar nicht') },
          { id: 'pq2', varId: 'DEMO_PAT_Q2', label: 'Wie stark beeinträchtigt Ihr Knie Sie beim Treppensteigen? (Demonstrationsfrage)', type: 'single', required: true, codes: scale('sehr stark', 'gar nicht') },
          { id: 'pq3', varId: 'DEMO_PAT_Q3', label: 'Wie gut können Sie nachts schlafen? (Demonstrationsfrage)', type: 'single', required: true, codes: scale('sehr schlecht', 'sehr gut'), allowedMissing: ['verweigert'] },
          { id: 'pq4', varId: 'DEMO_PAT_Q4', label: 'Wie zufrieden sind Sie insgesamt mit Ihrem Knie? (Demonstrationsfrage)', type: 'single', required: true, codes: scale('gar nicht', 'sehr'), allowedMissing: ['verweigert'] },
          { id: 'pscore', varId: 'DEMO_PAT_SCORE', label: 'Demonstrationsscore (kein validiertes Instrument)', type: 'computed', compute: { algorithm: 'DEMO-SCORE@1', inputs: ['pq1', 'pq2', 'pq3', 'pq4'] } },
        ],
      },
      {
        id: 'sport',
        title: 'Sport',
        items: [
          { id: 'psport', varId: 'DEMO_PAT_SPORT', label: 'Treiben Sie derzeit Sport? (Demonstrationsfrage)', type: 'yesno', required: true },
          { id: 'psport_art', varId: 'DEMO_PAT_SPORT_ART', label: 'Welche Sportart? (Demonstrationsfrage)', type: 'text', visibleIf: { eq: [{ var: 'psport' }, 'ja'] } },
        ],
      },
    ],
  },
];

export const DEMO_CONSENT_BODY = `DEMONSTRATIONSTEXT – keine rechtlich geprüfte Patienteninformation.

Teilnahme am Register DART (Demonstration)

Sie werden gebeten, an einem Register zur Qualitätssicherung und Forschung in der Gelenkchirurgie teilzunehmen. Ihre Teilnahme ist freiwillig. Wenn Sie nicht teilnehmen, entstehen Ihnen keine Nachteile für Ihre Behandlung.

Ihre medizinischen Angaben werden unter einem Pseudonym gespeichert. Name und Kontaktdaten werden getrennt in einem besonders geschützten Bereich aufbewahrt.

Sie können Ihre Einwilligung jederzeit ohne Angabe von Gründen widerrufen – im Patientenportal oder gegenüber Ihrem Zentrum. Weitere Befragungen werden dann sofort gestoppt. Der Umgang mit bereits erhobenen Daten richtet sich nach dem freigegebenen Datenschutzkonzept.

Sie erhalten eine Kopie dieser Erklärung im Patientenportal.

Ansprechpartner: Ihr behandelndes Zentrum (Demonstration).`;
