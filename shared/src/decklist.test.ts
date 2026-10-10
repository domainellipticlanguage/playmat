import { describe, it, expect } from 'vitest';
import { cardNameKey, frontFaceName, parseDecklist } from './decklist';
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

describe('parseDecklist: composite cards and export dialects', () => {
  const names = (t: string) => parseDecklist(t).entries.map((e) => e.name);

  it('normalizes MTGO single-slash split names', () => {
    expect(names('1 Fire/Ice\n1 Who/What/When/Where/Why\n1 Fire // Ice')).toEqual([
      'Fire // Ice',
      'Who // What // When // Where // Why',
      'Fire // Ice',
    ]);
  });

  it('captures printings from Moxfield / Arena / Archidekt lines', () => {
    const r = parseDecklist(
      [
        '1 Valki, God of Lies // Tibalt, Cosmic Impostor (KHM) 114',
        '1 Kytheon, Hero of Akros (PLST) ORI-23 *F*',
        '1x Fire // Ice (dmr) 215 [Removal] ^Have,#37d67a^',
        '1 Sol Ring (SLD) 1494★',
        '1 Brazen Borrower (ELD)',
      ].join('\n')
    );
    expect(r.entries.map(({ name, set, cn }) => ({ name, set, cn }))).toEqual([
      { name: 'Valki, God of Lies // Tibalt, Cosmic Impostor', set: 'khm', cn: '114' },
      { name: 'Kytheon, Hero of Akros', set: 'plst', cn: 'ORI-23' },
      { name: 'Fire // Ice', set: 'dmr', cn: '215' },
      { name: 'Sol Ring', set: 'sld', cn: '1494★' },
      { name: 'Brazen Borrower', set: 'eld', cn: undefined },
    ]);
  });

  it('handles Arena headers, About/Name metadata, and Companion', () => {
    const r = parseDecklist('About\nName Esika Lands\n\nCommander\n1 Esika, God of the Tree (KHM) 168\n\nCompanion\n1 Jegantha, the Wellspring (IKO) 222\n\nDeck\n1 Fire // Ice (DMR) 215');
    expect(r.entries.map((e) => [e.name, e.commander])).toEqual([
      ['Esika, God of the Tree', true],
      ['Fire // Ice', false],
    ]);
    expect(r.skipped.map((e) => e.name)).toEqual(['Jegantha, the Wellspring']);
    expect(r.problems).toEqual([]);
  });

  it('parses MTGO .dek XML', () => {
    const r = parseDecklist(`<?xml version="1.0" encoding="utf-8"?>
<Deck xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <NetDeckID>0</NetDeckID>
  <Cards CatID="1" Quantity="2" Sideboard="false" Name="Fire/Ice" Annotation="0" />
  <Cards CatID="2" Quantity="1" Sideboard="false" Name="Lim-D&#251;l&apos;s Vault" />
  <Cards CatID="3" Quantity="1" Sideboard="true" Name="Duress" />
</Deck>`);
    expect(r.entries.map((e) => [e.count, e.name])).toEqual([
      [2, 'Fire // Ice'],
      [1, "Lim-Dûl's Vault"],
    ]);
    expect(r.skipped.map((e) => e.name)).toEqual(['Duress']);
  });

  it('parses Cockatrice .cod XML', () => {
    const r = parseDecklist(`<?xml version="1.0" encoding="UTF-8"?>
<cockatrice_deck version="1">
  <deckname>Test</deckname>
  <zone name="main">
    <card number="1" name="Delver of Secrets // Insectile Aberration"/>
    <card number="3" name="Forest"/>
  </zone>
  <zone name="side"><card number="1" name="Duress"/></zone>
</cockatrice_deck>`);
    expect(r.entries.map((e) => [e.count, e.name])).toEqual([
      [1, 'Delver of Secrets // Insectile Aberration'],
      [3, 'Forest'],
    ]);
    expect(r.skipped).toHaveLength(1);
  });

  it('parses Forge .dck', () => {
    const r = parseDecklist('[metadata]\nName=Esika Lands\n[Commander]\n1 Esika, God of the Tree|KHM|1\n[Main]\n1 Fire // Ice|DMR\n2 Forest|MDD|1\n[Sideboard]\n1 Duress|M19');
    expect(r.entries.map(({ name, count, commander, set }) => [name, count, commander, set])).toEqual([
      ['Esika, God of the Tree', 1, true, 'khm'],
      ['Fire // Ice', 1, false, 'dmr'],
      ['Forest', 2, false, 'mdd'],
    ]);
    expect(r.skipped.map((e) => e.name)).toEqual(['Duress']);
    expect(r.problems).toEqual([]);
  });

  it('parses XMage .dck', () => {
    const r = parseDecklist('NAME:Esika Lands\n1 [DMR:215] Fire // Ice\n1 [KHM:114] Valki, God of Lies\nSB: 1 [M19:99] Duress\nLAYOUT MAIN:(1,1)(NONE,false,50)|([DMR:215])');
    expect(r.entries.map(({ name, set, cn }) => [name, set, cn])).toEqual([
      ['Fire // Ice', 'dmr', '215'],
      ['Valki, God of Lies', 'khm', '114'],
    ]);
    expect(r.skipped.map((e) => e.name)).toEqual(['Duress']);
    expect(r.problems).toEqual([]);
  });
});

describe('card name helpers', () => {
  it('frontFaceName takes the first face', () => {
    expect(frontFaceName('Fire // Ice')).toBe('Fire');
    expect(frontFaceName('Who // What // When // Where // Why')).toBe('Who');
    expect(frontFaceName('Sol Ring')).toBe('Sol Ring');
  });
  it('cardNameKey folds accents, ligatures, and curly quotes', () => {
    expect(cardNameKey('Lim-Dûl’s Vault')).toBe(cardNameKey("Lim-Dul's Vault"));
    expect(cardNameKey('Æther Vial')).toBe(cardNameKey('Aether Vial'));
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
