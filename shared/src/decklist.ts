/**
 * Plain-text decklist parser (D-1, D-5).
 *
 * Accepts the common export dialects:
 *   "1 Lightning Bolt"            plain / MTGO
 *   "1x Lightning Bolt"           Archidekt / Moxfield
 *   "Lightning Bolt"              bare name (count 1)
 *   "1x Abrade (voc) 148 [Removal]"        Archidekt export (set/collector/category)
 *   "1 Atraxa, Praetors' Voice *CMDR*"     Moxfield commander marker
 *   "// Commander" / "Commander:" section headers
 *   "SB: 1 Duress"                MTGO sideboard (skipped)
 *   "Sideboard" / "Maybeboard" section headers (their contents are skipped)
 *
 * Never throws; bad lines are surfaced in `problems` so the UI can offer
 * correction without blocking the rest of the import (D-3).
 */

export interface DeckEntry {
  count: number;
  name: string;
  commander: boolean;
  line: number;
}

export interface DeckProblem {
  line: number;
  text: string;
  reason: string;
}

export interface ParsedDecklist {
  entries: DeckEntry[];
  /** Lines skipped because they sit in a sideboard/maybeboard section. */
  skipped: DeckEntry[];
  problems: DeckProblem[];
}

type Section = 'main' | 'commander' | 'skip';

const SECTION_HEADERS: Record<string, Section> = {
  commander: 'commander',
  commanders: 'commander',
  'command zone': 'commander',
  deck: 'main',
  mainboard: 'main',
  main: 'main',
  creatures: 'main',
  spells: 'main',
  lands: 'main',
  artifacts: 'main',
  enchantments: 'main',
  instants: 'main',
  sorceries: 'main',
  planeswalkers: 'main',
  battles: 'main',
  sideboard: 'skip',
  maybeboard: 'skip',
  considering: 'skip',
  tokens: 'skip',
};

function headerSection(line: string): Section | null {
  // "// Commander", "//Sideboard", "Commander:", "Sideboard", "Sideboard (15)"
  let t = line.trim();
  if (t.startsWith('//')) t = t.slice(2).trim();
  t = t.replace(/:\s*$/, '').replace(/\s*\(\d+\)\s*$/, '').trim().toLowerCase();
  if (t in SECTION_HEADERS) return SECTION_HEADERS[t];
  return null;
}

export function parseDecklist(text: string): ParsedDecklist {
  const entries: DeckEntry[] = [];
  const skipped: DeckEntry[] = [];
  const problems: DeckProblem[] = [];
  let section: Section = 'main';

  const lines = text.split(/\r?\n/);
  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    let line = raw.trim();
    if (!line) return;

    // Section header? ("// Commander" must be checked before treating "//"
    // as noise; DFC card lines have text BEFORE the slashes, headers don't.)
    const sec = headerSection(line);
    if (sec !== null) {
      section = sec;
      return;
    }
    if (line.startsWith('//') || line.startsWith('#')) return; // comment

    let target: Section = section;
    if (/^SB:\s*/i.test(line)) {
      line = line.replace(/^SB:\s*/i, '');
      target = 'skip';
    }

    let commander = section === 'commander';

    // Moxfield-style commander marker
    if (/\*CMDR\*/i.test(line)) {
      commander = true;
      line = line.replace(/\s*\*CMDR\*\s*/gi, ' ').trim();
    }
    // Foil / etched markers
    line = line.replace(/\s*\*[FE]\*\s*/gi, ' ').trim();

    // Archidekt category suffix: [Removal], [Commander{top}]
    const catMatch = line.match(/\[([^\]]*)\]\s*$/);
    if (catMatch) {
      const cat = catMatch[1].toLowerCase();
      if (cat.startsWith('commander')) commander = true;
      if (cat.startsWith('sideboard') || cat.startsWith('maybeboard')) target = 'skip';
      line = line.slice(0, catMatch.index).trim();
    }

    // Count prefix
    let count = 1;
    const countMatch = line.match(/^(\d+)\s*[xX]?\s+(.*)$/);
    if (countMatch) {
      count = parseInt(countMatch[1], 10);
      line = countMatch[2].trim();
    }

    // Set/collector suffix: "(voc) 148", "(2X2) 117 *F*", "(PLST) XLN-38"
    line = line.replace(/\s*\((\w{2,6})\)\s+[\w-]+\s*$/, '').trim();
    // Bare set suffix: "(voc)"
    line = line.replace(/\s*\(\w{2,6}\)\s*$/, '').trim();

    if (!line) {
      problems.push({ line: lineNo, text: raw, reason: 'No card name found' });
      return;
    }
    if (count < 1 || count > 99 || Number.isNaN(count)) {
      problems.push({ line: lineNo, text: raw, reason: `Suspicious count: ${count}` });
      return;
    }

    const entry: DeckEntry = { count, name: line, commander, line: lineNo };
    if (target === 'skip') skipped.push(entry);
    else entries.push(entry);
  });

  return { entries, skipped, problems };
}
