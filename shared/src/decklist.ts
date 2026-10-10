/**
 * Decklist parser (D-1, D-5).
 *
 * Accepts the common text export dialects:
 *   "1 Lightning Bolt"            plain / MTGO
 *   "1x Lightning Bolt"           Archidekt / Moxfield
 *   "Lightning Bolt"              bare name (count 1)
 *   "1x Abrade (voc) 148 [Removal] ^Have,#37d67a^"   Archidekt export (set/collector/category/tags)
 *   "1 Fire // Ice (DMR) 215 *F*" Moxfield / Arena (set/collector, foil marker)
 *   "1 Fire/Ice"                  MTGO split-card spelling
 *   "1 Atraxa, Praetors' Voice *CMDR*"     Moxfield commander marker
 *   "// Commander" / "Commander:" / "[Main]" section headers
 *   "SB: 1 Duress"                MTGO / XMage sideboard (skipped)
 *   "Sideboard" / "Maybeboard" section headers (their contents are skipped)
 *   "About" / "Name …"            Arena deck metadata (ignored)
 * …and the deck *file* formats people export:
 *   .dek  MTGO XML      <Cards Quantity="1" Sideboard="false" Name="Fire/Ice" />
 *   .cod  Cockatrice    <zone name="main"><card number="1" name="Fire // Ice"/></zone>
 *   .dck  Forge         [metadata] Name=… / [Main] / "1 Fire // Ice|DMR|1"
 *   .dck  XMage         "1 [DMR:215] Fire // Ice", "LAYOUT …", "NAME:…"
 *
 * Composite cards (split, MDFC, transform, adventure, flip…) keep their full
 * "A // B" name here; resolution against Scryfall happens by face name (see
 * `frontFaceName`), because Scryfall's collection endpoint 404s full names.
 *
 * Never throws; bad lines are surfaced in `problems` so the UI can offer
 * correction without blocking the rest of the import (D-3).
 */

export interface DeckEntry {
  count: number;
  name: string;
  commander: boolean;
  line: number;
  /** Printing hints from the export, when present (lowercased set code). */
  set?: string;
  cn?: string;
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

/** 'meta' sections hold non-card lines (Arena "About", Forge "[metadata]"). */
type Section = 'main' | 'commander' | 'skip' | 'meta';

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
  side: 'skip',
  maybeboard: 'skip',
  considering: 'skip',
  tokens: 'skip',
  companion: 'skip',
  about: 'meta',
  metadata: 'meta',
};

function headerSection(line: string): Section | null {
  // "// Commander", "//Sideboard", "Commander:", "Sideboard", "Sideboard (15)", "[Main]"
  let t = line.trim();
  if (t.startsWith('//')) t = t.slice(2).trim();
  const bracketed = t.match(/^\[([^\]]+)\]$/);
  if (bracketed) t = bracketed[1];
  t = t.replace(/:\s*$/, '').replace(/\s*\(\d+\)\s*$/, '').trim().toLowerCase();
  if (t in SECTION_HEADERS) return SECTION_HEADERS[t];
  return null;
}

/**
 * The name Scryfall's collection endpoint will accept for a card: it resolves
 * face names ("Fire", "Valki, God of Lies") but not full composite names
 * ("Fire // Ice") — those come back not_found.
 */
export function frontFaceName(name: string): string {
  return name.split(/\s*\/\/\s*/)[0].trim();
}

/** Comparison key for card names: case, accents, ligatures, curly quotes. */
export function cardNameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

function xmlAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    out[m[1].toLowerCase()] = decodeXml(m[3] ?? m[4] ?? '');
  }
  return out;
}

/** MTGO spells split cards "Fire/Ice"; everyone else writes "Fire // Ice". */
function normalizeSlashes(name: string): string {
  if (name.includes('//') || !name.includes('/')) return name;
  return name.split(/\s*\/\s*/).join(' // ');
}

/** MTGO .dek and Cockatrice .cod are XML; regex is plenty for their flat shape. */
function parseXmlDeck(text: string): ParsedDecklist {
  const entries: DeckEntry[] = [];
  const skipped: DeckEntry[] = [];
  const problems: DeckProblem[] = [];
  let zone: Section = 'main';
  for (const m of text.matchAll(/<(zone|Cards|card)\b([^>]*)>/gi)) {
    const line = text.slice(0, m.index).split('\n').length;
    const tag = m[1].toLowerCase();
    const a = xmlAttrs(m[2]);
    if (tag === 'zone') {
      zone = headerSection(a.name ?? '') ?? 'skip';
      continue;
    }
    // .dek uses <Cards Quantity Name Sideboard>, .cod uses <card number name>.
    const count = parseInt(a.quantity ?? a.number ?? '1', 10);
    const name = normalizeSlashes((a.name ?? '').trim());
    if (!name) {
      problems.push({ line, text: m[0], reason: 'No card name found' });
      continue;
    }
    if (!(count >= 1 && count <= 99)) {
      problems.push({ line, text: m[0], reason: `Suspicious count: ${a.quantity ?? a.number}` });
      continue;
    }
    const target: Section = a.sideboard === 'true' ? 'skip' : zone;
    const entry: DeckEntry = { count, name, commander: target === 'commander', line };
    if (target === 'skip' || target === 'meta') skipped.push(entry);
    else entries.push(entry);
  }
  return { entries, skipped, problems };
}

export function parseDecklist(text: string): ParsedDecklist {
  if (/^\s*<(\?xml|Deck|cockatrice_deck)\b/i.test(text)) return parseXmlDeck(text);

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
    if (section === 'meta') return;
    if (line.startsWith('//') || line.startsWith('#')) return; // comment
    if (/^(LAYOUT\b|NAME:)/.test(line)) return; // XMage .dck metadata

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
    // Archidekt tags: ^Have,#37d67a^
    line = line.replace(/\s*\^[^^]*\^/g, '').trim();

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

    let set: string | undefined;
    let cn: string | undefined;

    // XMage printing prefix: "[DMR:215] Fire // Ice"
    const xmage = line.match(/^\[(\w+):([^\]]+)\]\s*(.*)$/);
    if (xmage) {
      [, set, cn, line] = xmage;
    }
    // Forge printing suffix: "Fire // Ice|DMR|1" (the trailing number is an
    // art index, not a collector number)
    const forge = line.match(/^(.*?)\|(\w+)(?:\|.*)?$/);
    if (forge) {
      line = forge[1].trim();
      set = forge[2];
    }

    // Set/collector suffix: "(voc) 148", "(PLST) XLN-38", "(SLD) 1494★"
    const printing = line.match(/\s*\(([A-Za-z0-9]{2,6})\)\s+(\S+)\s*$/);
    if (printing) {
      set = printing[1];
      cn = printing[2];
      line = line.slice(0, printing.index).trim();
    } else {
      // Bare set suffix: "(voc)"
      const bare = line.match(/\s*\(([A-Za-z0-9]{2,6})\)\s*$/);
      if (bare) {
        set = bare[1];
        line = line.slice(0, bare.index).trim();
      }
    }

    line = normalizeSlashes(line);

    if (!line) {
      problems.push({ line: lineNo, text: raw, reason: 'No card name found' });
      return;
    }
    if (count < 1 || count > 99 || Number.isNaN(count)) {
      problems.push({ line: lineNo, text: raw, reason: `Suspicious count: ${count}` });
      return;
    }

    const entry: DeckEntry = { count, name: line, commander, line: lineNo };
    if (set) entry.set = set.toLowerCase();
    if (cn) entry.cn = cn;
    if (target === 'skip') skipped.push(entry);
    else entries.push(entry);
  });

  return { entries, skipped, problems };
}
