/** DART-2.0-Entwurfstokens (Gestaltungsvorschlag, kein bestehender Styleguide). */
export const tokens = {
  navy: '#12304A',
  blue: '#1559B7',
  teal: '#087F83',
  mint: '#DDF4EC',
  green: '#58C99A',
  surface: '#FFFFFF',
  background: '#F4F7FA',
  text: '#183247',
  muted: '#526575',
  border: '#CBD5DF',
  danger: '#B42318',
  warning: '#8A4B08',
} as const;

/** Geprüfte Farbpaare (Vordergrund/Hintergrund) für WCAG 2.2 AA. */
export const contrastPairs: Array<[keyof typeof tokens, keyof typeof tokens]> = [
  ['surface', 'navy'], ['surface', 'blue'], ['surface', 'teal'], ['text', 'mint'], ['text', 'green'],
  ['text', 'surface'], ['text', 'background'], ['muted', 'surface'], ['danger', 'surface'], ['warning', 'surface'], ['blue', 'surface'], ['teal', 'surface'],
];

function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
