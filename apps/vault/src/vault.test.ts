import { describe, expect, it } from 'vitest';
import { checkUpload, demoScanner, sniffType } from './scanner';
import { decrypt, encrypt, hashSecret, nameIndex, verifySecret } from './crypto';

const KEY = Buffer.alloc(32, 7);
const pdf = Buffer.from('%PDF-1.4\n%synthetisch\n');
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

describe('Upload-Prüfung', () => {
  it('erkennt Typen am Inhalt', () => {
    expect(sniffType(pdf)).toBe('application/pdf');
    expect(sniffType(png)).toBe('image/png');
    expect(sniffType(Buffer.from('MZ\x90\x00'))).toBeNull();
  });
  it('lehnt falschen Typ, Übergröße, Exe und Malware ab', async () => {
    expect((await checkUpload(Buffer.from('MZ....'), 'application/pdf', 1000, demoScanner)).status).toBe('abgelehnt');
    expect((await checkUpload(pdf, 'image/png', 1000, demoScanner)).status).toBe('abgelehnt');
    expect((await checkUpload(pdf, 'application/pdf', 5, demoScanner)).detail).toMatch(/zu groß/);
    expect((await checkUpload(Buffer.concat([pdf, Buffer.from(EICAR)]), 'application/pdf', 1000, demoScanner)).status).toBe('infiziert');
    expect((await checkUpload(pdf, 'application/pdf', 1000, demoScanner)).status).toBe('sauber');
  });
});

describe('Kryptografie', () => {
  it('AES-GCM rundet und erkennt Manipulation', () => {
    const c = encrypt(KEY, 'Erika');
    expect(decrypt(KEY, c).toString()).toBe('Erika');
    c[c.length - 1] ^= 1;
    expect(() => decrypt(KEY, c)).toThrow();
  });
  it('Zugangscode gehasht, Namensindex normalisiert', () => {
    const h = hashSecret('ABCD-2345');
    expect(verifySecret('abcd2345', h)).toBe(true);
    expect(verifySecret('ABCD2346', h)).toBe(false);
    expect(nameIndex(KEY, 'Müller')).toBe(nameIndex(KEY, ' muller'));
  });
});
