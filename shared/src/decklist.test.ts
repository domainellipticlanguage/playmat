import { describe, it, expect } from 'vitest';
import { parseDecklist } from './decklist';
import { supersedes } from './protocol';
import { normalizeRoomCode, newRoomCode, shuffled } from './util';

describe('parseDecklist', () => {
  it('parses plain and 1x lines', () => {
    const r = parseDecklist('1 Lightning Bolt\n2x Mountain\nSol Ring');
    expect(r.entries).toEqual([
      { count: 1, name: 'Lightning Bolt', commander: false, line: 1 },
      { count: 2, name: 'Mountain', commander: false, line: 2 },
      { count: 1, name: 'Sol Ring', commander: false, line: 3 },
    ]);
    expect(r.problems).toEqual([]);
  });

  it('handles // Commander section headers', () => {
    const r = parseDecklist('// Commander\n1 Atraxa, Praetors’ Voice\n// Deck\n1 Sol Ring');
    expect(r.entries[0]).toMatchObject({ name: 'Atraxa, Praetors’ Voice', commander: true });
    expect(r.entries[1]).toMatchObject({ name: 'Sol Ring', commander: false });
  });

  it('handles Commander: header and *CMDR* marker', () => {
    const r = parseDecklist('Commander:\n1 Muldrotha, the Gravetide\nDeck\n1 Golgari Rot Farm\n1 Kodama of the East Tree *CMDR*');
    expect(r.entries[0].commander).toBe(true);
    expect(r.entries[1].commander).toBe(false);
    expect(r.entries[2]).toMatchObject({ name: 'Kodama of the East Tree', commander: true });
  });

  it('strips Archidekt set/collector/category suffixes', () => {
    const r = parseDecklist('1x Abrade (voc) 148 [Removal]\n1x Yuriko, the Tiger’s Shadow (cm2) 51 [Commander{top}]');
    expect(r.entries[0]).toMatchObject({ name: 'Abrade', commander: false });
    expect(r.entries[1]).toMatchObject({ name: 'Yuriko, the Tiger’s Shadow', commander: true });
  });

  it('keeps DFC names intact', () => {
    const r = parseDecklist('1 Fable of the Mirror-Breaker // Reflection of Kiki-Jiki');
    expect(r.entries[0].name).toBe('Fable of the Mirror-Breaker // Reflection of Kiki-Jiki');
  });

  it('skips sideboard sections and SB: lines', () => {
    const r = parseDecklist('1 Ponder\nSideboard\n1 Duress\n');
    expect(r.entries).toHaveLength(1);
    expect(r.skipped).toHaveLength(1);
    const r2 = parseDecklist('1 Ponder\nSB: 1 Duress');
    expect(r2.entries).toHaveLength(1);
    expect(r2.skipped[0].name).toBe('Duress');
  });

  it('handles foil markers and blank lines', () => {
    const r = parseDecklist('\n1 Sol Ring *F*\n\n27 Forest\n');
    expect(r.entries[0].name).toBe('Sol Ring');
    expect(r.entries[1]).toMatchObject({ name: 'Forest', count: 27 });
  });
});

describe('supersedes', () => {
  it('orders by seq then by publisher id', () => {
    expect(supersedes({ seq: 2, by: 'a' }, { seq: 1, by: 'z' })).toBe(true);
    expect(supersedes({ seq: 1, by: 'a' }, { seq: 2, by: 'z' })).toBe(false);
    expect(supersedes({ seq: 1, by: 'b' }, { seq: 1, by: 'a' })).toBe(true);
    expect(supersedes({ seq: 1, by: 'a' }, { seq: 1, by: 'a' })).toBe(false);
    expect(supersedes({ seq: 1, by: 'a' }, undefined)).toBe(true);
  });
});

describe('room codes', () => {
  it('generates codes from the unambiguous alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const code = newRoomCode();
      expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/);
    }
  });
  it('normalizes user input', () => {
    expect(normalizeRoomCode(' ab-cd2 ')).toBe('ABCD2');
  });
});

describe('shuffled', () => {
  it('preserves elements', () => {
    const a = Array.from({ length: 100 }, (_, i) => i);
    const s = shuffled(a);
    expect(s).toHaveLength(100);
    expect([...s].sort((x, y) => x - y)).toEqual(a);
    expect(a[0]).toBe(0); // original untouched
  });
});
