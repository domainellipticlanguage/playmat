import { useEffect, useMemo, useState } from 'react';
import type { PoolCard } from '@playmat/shared';
import { newGuid, parseDecklist } from '@playmat/shared';
import { useGame } from '../store';
import { useUI, type ModalState } from '../uiStore';
import * as actions from '../actions';
import { deckColorIdentity, manaSymbolUrl } from '../cards';
import { PLAYER_PALETTE, paletteColor } from '../colors';
import { resolveDeckByNames, resolveByIds, searchTokens, toPoolCard, type ScryfallCard } from '../scryfall';
import { fetchArchidektDeck, parseArchidektUrl } from '../archidekt';
import { persisted } from '../session';
import { CardView } from './CardView';

function Backdrop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal fade-pop">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Peek / scry / surveil (C-8)
// ---------------------------------------------------------------------------

function PeekModal({ count, onClose }: { count: number; onClose: () => void }) {
  const pool = useGame((s) => s.pool);
  const library = useGame((s) => s.hidden.library);
  const seen = library.slice(0, count);
  const [dests, setDests] = useState<Record<string, 'top' | 'bottom' | 'hand' | 'graveyard' | 'exile'>>(
    Object.fromEntries(seen.map((g) => [g, 'top']))
  );
  const [order, setOrder] = useState(seen);

  const move = (guid: string, dir: -1 | 1) => {
    setOrder((o) => {
      const i = o.indexOf(guid);
      const j = i + dir;
      if (j < 0 || j >= o.length) return o;
      const next = o.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const commit = () => {
    for (const guid of order) {
      const dest = dests[guid];
      if (dest === 'hand' || dest === 'graveyard' || dest === 'exile') {
        actions.moveCard(guid, { zone: dest === 'hand' ? 'hand' : dest });
      }
    }
    const remaining = order.filter((g) => dests[g] === 'top' || dests[g] === 'bottom');
    actions.commitPeek({
      seen: remaining.length,
      keepTop: order.filter((g) => dests[g] === 'top'),
      toBottom: order.filter((g) => dests[g] === 'bottom'),
      label: `looked at the top ${seen.length}`,
    });
    onClose();
  };

  return (
    <Backdrop onClose={onClose}>
      <h3>Top {seen.length} of your library</h3>
      <div className="card-grid">
        {order.map((guid, i) => {
          const p = pool[guid];
          return (
            <div key={guid} className="gcard">
              <CardView pool={p} />
              <div className="glabel">#{i + 1} → {dests[guid]}</div>
              <div className="gactions">
                <button className="small" onClick={() => move(guid, -1)}>◀ earlier</button>
                <button className="small" onClick={() => move(guid, 1)}>later ▶</button>
                {(['top', 'bottom', 'hand', 'graveyard', 'exile'] as const).map((d) => (
                  <button
                    key={d}
                    className={`small${dests[guid] === d ? ' primary' : ''}`}
                    onClick={() => setDests((s) => ({ ...s, [guid]: d }))}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <span className="glabel" style={{ alignSelf: 'center', color: 'var(--ink-dim)' }}>
          "earlier" = closer to the top. Covers scry, surveil, and impulse draws.
        </span>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={commit}>Done</button>
      </div>
    </Backdrop>
  );
}

// ---------------------------------------------------------------------------
// Search library (C-8 / Archidekt-style)
// ---------------------------------------------------------------------------

function SearchModal({ ownerId, onClose }: { ownerId?: string; onClose: () => void }) {
  const pool = useGame((s) => s.pool);
  const session = useGame((s) => s.session);
  const players = useGame((s) => s.players);
  const myLibrary = useGame((s) => s.hidden.library);
  // A peer's order arrives on their PlayerState; mine is authoritative locally.
  const theirLibrary = useGame((s) => (ownerId ? s.playerStates[ownerId]?.library : undefined));
  const isMine = !ownerId || ownerId === session?.playerId;
  const library = isMine ? myLibrary : theirLibrary ?? [];
  const ownerName = isMine ? 'your' : `${players.find((p) => p.playerId === ownerId)?.name ?? '?'}'s`;
  const [q, setQ] = useState('');
  const [touched, setTouched] = useState(false);

  const shown = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const guids = ql
      ? library.filter((g) => (pool[g]?.sf?.name ?? '').toLowerCase().includes(ql))
      : library;
    // Sort alphabetically so library order leaks nothing at a glance.
    return [...guids].sort((a, b) => (pool[a]?.sf?.name ?? '').localeCompare(pool[b]?.sf?.name ?? ''));
  }, [q, library, pool]);

  const take = (guid: string, where: 'hand' | 'battlefield' | 'graveyard' | 'command') => {
    setTouched(true);
    if (where === 'battlefield') {
      // Slots into the OWNER's rows — lands by their edge, spells centered.
      actions.moveCard(guid, { zone: 'battlefield', ...actions.autoPlayPosition(guid) });
    } else {
      actions.moveCard(guid, { zone: where });
    }
  };

  const close = () => {
    // Convention: searching a library means shuffling it afterwards. Only the
    // owner holds the authoritative order, so searching someone else's leaves
    // the shuffle to them — the log line above tells them to.
    if (touched && isMine) actions.shuffleLibrary();
    onClose();
  };

  return (
    <Backdrop onClose={close}>
      <h3>Search {ownerName} library ({library.length})</h3>
      <input autoFocus placeholder="Filter by name…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="card-grid">
        {shown.map((guid) => {
          const p = pool[guid];
          return (
            <div key={guid} className="gcard">
              <CardView pool={p} />
              <div className="gactions">
                <button className="small" onClick={() => take(guid, 'hand')}>to hand</button>
                <button className="small" onClick={() => take(guid, 'battlefield')}>battlefield</button>
                <button className="small" onClick={() => take(guid, 'graveyard')}>graveyard</button>
                <button className="small" onClick={() => take(guid, 'command')}>command</button>
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
        <span className="glabel" style={{ color: 'var(--ink-dim)', alignSelf: 'center' }}>
          {!isMine
            ? 'Cards go to their owner. Ask them to shuffle when you\'re done.'
            : touched
              ? 'Library will shuffle when you close.'
              : 'Take a card and the library shuffles on close.'}
        </span>
        <button className="primary" onClick={close}>Close{touched && isMine ? ' & shuffle' : ''}</button>
      </div>
    </Backdrop>
  );
}

// ---------------------------------------------------------------------------
// Zone viewer: graveyard / exile / command (Z-4, Z-5)
// ---------------------------------------------------------------------------

function ZoneModal({
  zone,
  zoneOwnerId,
  onClose,
}: {
  zone: 'graveyard' | 'exile' | 'command';
  zoneOwnerId: string;
  onClose: () => void;
}) {
  const pool = useGame((s) => s.pool);
  const cards = useGame((s) => s.cards);
  const players = useGame((s) => s.players);
  const ownerName = players.find((p) => p.playerId === zoneOwnerId)?.name ?? '?';

  const list = useMemo(
    () =>
      Object.values(cards)
        .filter((c) => c.zone === zone && (c.zoneOwnerId ?? c.ownerId) === zoneOwnerId)
        .sort((a, b) => b.order - a.order),
    [cards, zone, zoneOwnerId]
  );

  return (
    <Backdrop onClose={onClose}>
      <h3>
        {ownerName}'s {zone} ({list.length})
      </h3>
      <div className="card-grid">
        {list.map((c) => {
          const p = pool[c.guid];
          const tax = c.counters['tax'] ?? 0;
          return (
            <div key={c.guid} className="gcard">
              <CardView pool={p} rotIndex={c.rotIndex} />
              {zone === 'command' && (
                <div className="glabel">
                  commander tax: {tax * 2 > 0 ? `+${tax * 2}` : '0'}{' '}
                  <button className="small" onClick={() => actions.setCounter(c.guid, 'tax', tax + 1)}>+</button>
                  <button className="small" onClick={() => actions.setCounter(c.guid, 'tax', Math.max(0, tax - 1))}>−</button>
                </div>
              )}
              <div className="gactions">
                <button
                  className="small"
                  onClick={() => actions.moveCard(c.guid, { zone: 'battlefield', ...actions.autoPlayPosition(c.guid) })}
                >
                  battlefield
                </button>
                {/* Destination owner is implicit now — moveCard always routes a
                    card to its own owner's zones. */}
                <button className="small" onClick={() => actions.moveCard(c.guid, { zone: 'hand' })}>owner's hand</button>
                {zone !== 'graveyard' && (
                  <button className="small" onClick={() => actions.moveCard(c.guid, { zone: 'graveyard' })}>graveyard</button>
                )}
                {zone !== 'exile' && (
                  <button className="small" onClick={() => actions.moveCard(c.guid, { zone: 'exile' })}>exile</button>
                )}
                <button className="small" onClick={() => actions.moveCard(c.guid, { zone: 'library', libPos: 'top' })}>library top</button>
                <button className="small" onClick={() => actions.moveCard(c.guid, { zone: 'library', libPos: 'bottom' })}>library bottom</button>
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ textAlign: 'right' }}>
        <button className="primary" onClick={onClose}>Close</button>
      </div>
    </Backdrop>
  );
}

// ---------------------------------------------------------------------------
// Tokens (C-7 + custom via crucible)
// ---------------------------------------------------------------------------

const QUICK_TOKENS: { label: string; q: string }[] = [
  { label: 'Treasure', q: 'Treasure' },
  { label: 'Food', q: 'Food' },
  { label: 'Clue', q: 'Clue' },
  { label: 'Blood', q: 'Blood' },
  { label: 'Soldier 1/1', q: 'Soldier' },
  { label: 'Zombie 2/2', q: 'Zombie' },
  { label: 'Goblin 1/1', q: 'Goblin' },
  { label: 'Spirit 1/1 flying', q: 'Spirit' },
  { label: 'Beast 3/3', q: 'Beast' },
  { label: 'Dragon 5/5', q: 'Dragon' },
];

function CustomPreview({ data }: { data: Record<string, unknown> }) {
  // Live preview: re-render 350ms after the last edit. CardView keeps the
  // previous image up while crucible draws the new one, so it never flickers.
  const json = JSON.stringify(data);
  const [settled, setSettled] = useState(json);
  useEffect(() => {
    const t = setTimeout(() => setSettled(json), 350);
    return () => clearTimeout(t);
  }, [json]);
  return (
    <CardView
      pool={{ guid: `preview-${settled}`, ownerId: '', custom: JSON.parse(settled) }}
      style={{ width: 220, alignSelf: 'flex-start' }}
    />
  );
}

const TOKEN_COLORS: { code: string; frame: string }[] = [
  { code: 'W', frame: 'white' },
  { code: 'U', frame: 'blue' },
  { code: 'B', frame: 'black' },
  { code: 'R', frame: 'red' },
  { code: 'G', frame: 'green' },
];

function TokenModal({ at, onClose }: { at: { x: number; y: number }; onClose: () => void }) {
  const session = useGame((s) => s.session);
  const [tab, setTab] = useState<'search' | 'custom'>('search');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<ScryfallCard[]>([]);
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState({ name: 'Token', typeLine: 'Token Creature — Shape', power: '1', toughness: '1', abilities: '', artUrl: '' });
  const [colors, setColors] = useState<string[]>([]);

  const me = session?.playerId ?? '';

  // Pool-shaped copies of the search results so they render via CardView.
  const resultPools = useMemo(
    () => new Map(results.map((c) => [c.id, toPoolCard(c, '', false, true)])),
    [results]
  );

  /** Crucible CardData for the custom token. Colors drive typeLineColor
   * only — no accentColor, no color indicator. */
  const buildCustomData = (): Record<string, unknown> => {
    const data: Record<string, unknown> = {
      name: custom.name || 'Token',
      typeLine: custom.typeLine || 'Token',
      rarity: 'common',
    };
    if (custom.abilities.trim()) data.abilities = custom.abilities;
    if (/creature/i.test(custom.typeLine)) {
      data.power = custom.power || '1';
      data.toughness = custom.toughness || '1';
    }
    if (custom.artUrl.trim()) data.artUrl = custom.artUrl.trim();
    if (colors.length > 0) {
      const frames = TOKEN_COLORS.filter((c) => colors.includes(c.code)).map((c) => c.frame);
      data.typeLineColor = frames.length === 1 ? frames[0] : frames;
    }
    return data;
  };

  const search = async (term: string) => {
    setBusy(true);
    try {
      setResults(await searchTokens(term));
    } catch {
      setResults([]);
    } finally {
      setBusy(false);
    }
  };

  const spawn = (card: ScryfallCard, n = 1) => {
    const tokens: PoolCard[] = [];
    for (let i = 0; i < n; i++) tokens.push(toPoolCard(card, me, false, true));
    actions.createTokens(tokens, at);
    onClose();
  };

  const spawnCustom = () => {
    actions.createTokens([{ guid: newGuid(), ownerId: me, isToken: true, custom: buildCustomData() }], at);
    onClose();
  };

  return (
    <Backdrop onClose={onClose}>
      <h3>Create a token</h3>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className={tab === 'search' ? 'primary' : ''} onClick={() => setTab('search')}>Scryfall tokens</button>
        <button className={tab === 'custom' ? 'primary' : ''} onClick={() => setTab('custom')}>Custom (rendered by crucible)</button>
      </div>
      {tab === 'search' ? (
        <>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {QUICK_TOKENS.map((t) => (
              <button key={t.label} className="small" onClick={() => { setQ(t.q); void search(t.q); }}>
                {t.label}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              autoFocus
              placeholder="Search token name…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && q.trim() && void search(q)}
              style={{ flex: 1 }}
            />
            <button disabled={busy || !q.trim()} onClick={() => void search(q)}>{busy ? '…' : 'Search'}</button>
          </div>
          <div className="card-grid">
            {results.map((card) => (
              <div key={card.id} className="gcard">
                <CardView pool={resultPools.get(card.id)} />
                <div className="glabel">{card.name}</div>
                <div className="gactions">
                  <button className="small" onClick={() => spawn(card, 1)}>create 1</button>
                  <button className="small" onClick={() => spawn(card, 2)}>create 2</button>
                  <button className="small" onClick={() => spawn(card, 4)}>create 4</button>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', gap: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
            <input placeholder="Name" value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} />
            <input placeholder="Type line" value={custom.typeLine} onChange={(e) => setCustom({ ...custom, typeLine: e.target.value })} />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input placeholder="P" style={{ width: 60 }} value={custom.power} onChange={(e) => setCustom({ ...custom, power: e.target.value })} />
              <input placeholder="T" style={{ width: 60 }} value={custom.toughness} onChange={(e) => setCustom({ ...custom, toughness: e.target.value })} />
              <span className="subtle" style={{ marginLeft: 8 }}>Color:</span>
              {TOKEN_COLORS.map(({ code }) => (
                <button
                  key={code}
                  className="small"
                  title={`${code} frame accents`}
                  style={{
                    padding: 3,
                    lineHeight: 0,
                    outline: colors.includes(code) ? '2px solid var(--accent)' : 'none',
                  }}
                  onClick={() =>
                    setColors((cs) => (cs.includes(code) ? cs.filter((c) => c !== code) : [...cs, code]))
                  }
                >
                  <img src={manaSymbolUrl(code)} alt={code} style={{ width: 16, height: 16, display: 'block' }} draggable={false} />
                </button>
              ))}
            </div>
            <input
              placeholder="Art image URL (optional)"
              value={custom.artUrl}
              onChange={(e) => setCustom({ ...custom, artUrl: e.target.value })}
            />
            <textarea
              placeholder="Rules text (optional)"
              rows={3}
              value={custom.abilities}
              onChange={(e) => setCustom({ ...custom, abilities: e.target.value })}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="primary" onClick={spawnCustom}>Create token</button>
            </div>
          </div>
          <CustomPreview data={buildCustomData()} />
        </div>
      )}
    </Backdrop>
  );
}

// ---------------------------------------------------------------------------
// Deck import (D-1..D-5)
// ---------------------------------------------------------------------------

function ImportModal({ onClose }: { onClose: () => void }) {
  const session = useGame((s) => s.session);
  const stored = persisted.get();
  const [text, setText] = useState(stored.decklistText ?? '');
  const [url, setUrl] = useState(stored.archidektUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [pending, setPending] = useState<PoolCard[] | null>(null);
  const [commanderPick, setCommanderPick] = useState<string | null>(null);
  const [deckName, setDeckName] = useState<string | null>(null);
  const [savedDecks, setSavedDecks] = useState(() => persisted.listDecks());

  const me = session?.playerId ?? '';

  /** One-click import of a saved deck: fresh guids, no Scryfall/Archidekt. */
  const importSaved = (deckId: string) => {
    const deck = savedDecks.find((d) => d.id === deckId);
    if (!deck) return;
    actions.importDeck(deck.cards.map((c) => ({ ...c, guid: newGuid(), ownerId: me })));
    persisted.saveDeck(deck.name, deck.cards.map((c) => ({ ...c, guid: '', ownerId: '' }))); // bump recency
    onClose();
  };

  const resolveText = async () => {
    setBusy(true);
    setProblems([]);
    setStatus('Parsing decklist…');
    try {
      setDeckName(null); // pasted lists have no name; fall back to commander
      const parsed = parseDecklist(text);
      if (parsed.entries.length === 0) throw new Error('No cards found in the list.');
      setStatus(`Resolving ${parsed.entries.length} lines via Scryfall…`);
      const { cards, notFound } = await resolveDeckByNames(parsed.entries, me);
      const probs = [
        ...parsed.problems.map((p) => `line ${p.line}: ${p.reason} — "${p.text.trim()}"`),
        ...notFound.map((n) => `not found on Scryfall: "${n}"`),
      ];
      setProblems(probs);
      setPending(cards);
      setStatus(`${cards.length} cards ready${probs.length ? ` — ${probs.length} problem(s) skipped` : ''}.`);
      persisted.patch({ decklistText: text });
    } catch (err) {
      setStatus(null);
      setProblems([String((err as Error).message ?? err)]);
    } finally {
      setBusy(false);
    }
  };

  const resolveUrl = async () => {
    const deckId = parseArchidektUrl(url);
    if (!deckId) {
      setProblems(['That does not look like an Archidekt deck URL.']);
      return;
    }
    setBusy(true);
    setProblems([]);
    try {
      setStatus('Fetching from Archidekt…');
      const deck = await fetchArchidektDeck(deckId);

      // Mirror the fetched deck into the textarea: inspectable, editable, and
      // re-resolvable by name if tweaked.
      const commanders = deck.entries.filter((e) => e.commander);
      const rest = deck.entries.filter((e) => !e.commander);
      const lines: string[] = [];
      if (commanders.length) {
        lines.push('// Commander');
        for (const e of commanders) lines.push(`${e.count}x ${e.name}`);
        lines.push('', '// Deck');
      }
      for (const e of rest) lines.push(`${e.count}x ${e.name}`);
      const listText = lines.join('\n');
      setText(listText);

      setDeckName(deck.name);
      setStatus(`Resolving ${deck.entries.length} cards via Scryfall…`);
      const { cards, notFound } = await resolveByIds(deck.entries, me);
      persisted.patch({ archidektUrl: url, decklistText: listText });
      // A clean fetch IS choosing the deck — no extra confirm click. Only an
      // imperfect resolve drops to the review flow below.
      if (notFound.length === 0 && cards.length > 0) {
        persisted.saveDeck(deck.name, cards);
        actions.importDeck(cards);
        onClose();
        return;
      }
      setProblems(notFound.map((n) => `unresolved id: ${n}`));
      setPending(cards);
      setStatus(`"${deck.name}" — ${cards.length} cards ready (decklist shown below; edit + Resolve to override).`);
    } catch (err) {
      setStatus(null);
      setProblems([String((err as Error).message ?? err)]);
    } finally {
      setBusy(false);
    }
  };

  const commanders = pending?.filter((c) => c.commander) ?? [];
  const uniqueNames = useMemo(
    () => [...new Set((pending ?? []).map((c) => c.sf?.name ?? ''))].sort(),
    [pending]
  );

  const doImport = () => {
    if (!pending) return;
    let cards = pending;
    if (commanders.length === 0 && commanderPick) {
      let done = false;
      cards = pending.map((c) => {
        if (!done && c.sf?.name === commanderPick) {
          done = true;
          return { ...c, commander: true };
        }
        return c;
      });
    }
    // Remember the deck for one-click reuse in future rooms.
    const cmdrNames = cards.filter((c) => c.commander).map((c) => c.sf?.name).filter(Boolean);
    const name = deckName ?? (cmdrNames[0] as string | undefined) ?? `Deck (${cards.length} cards)`;
    persisted.saveDeck(name, cards);
    actions.importDeck(cards);
    onClose();
  };

  return (
    <Backdrop onClose={onClose}>
      <div className="modal-head">
        <h3>Choose a deck</h3>
        <button className="modal-close" onClick={onClose} title="Close" aria-label="Close">✕</button>
      </div>
      {savedDecks.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="subtle">Your decks (saved on this device — no re-resolving needed):</span>
          {savedDecks.map((d) => {
            // Commander art as the deck's face ("oh yeah, my Animar deck").
            // Scryfall's CDN serves an art crop at the same path as the card image.
            const faceCard = d.cards.find((c) => c.commander) ?? d.cards[0];
            const cardImg = faceCard?.sf?.faces[0]?.img;
            const artCrop = cardImg?.replace('/normal/', '/art_crop/');
            return (
              <div key={d.id} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                {artCrop && (
                  <img
                    src={artCrop}
                    alt=""
                    style={{ width: 72, height: 52, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--panel-border)', cursor: 'pointer', flexShrink: 0 }}
                    onClick={() => importSaved(d.id)}
                    onError={(e) => {
                      // Art crop missing for this printing — fall back to the card face.
                      if (cardImg && e.currentTarget.src !== cardImg) e.currentTarget.src = cardImg;
                    }}
                  />
                )}
                <button className="primary small" onClick={() => importSaved(d.id)}>
                  Choose
                </button>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <b>{d.name}</b>
                  {deckColorIdentity(d.cards).map((c) => (
                    <img key={c} src={manaSymbolUrl(c)} alt={c} style={{ width: 15, height: 15, flexShrink: 0 }} />
                  ))}
                  <span className="subtle" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {d.count} cards
                    {d.commanders.length && d.commanders.join(' + ') !== d.name
                      ? ` · ${d.commanders.join(' + ')}`
                      : ''}
                    {` · ${new Date(d.savedAt).toLocaleDateString()}`}
                  </span>
                </span>
                <button
                  className="small"
                  title="Forget this deck"
                  onClick={() => {
                    persisted.deleteDeck(d.id);
                    setSavedDecks(persisted.listDecks());
                  }}
                >
                  ✕
                </button>
              </div>
            );
          })}
          <div style={{ borderTop: '1px solid var(--panel-border)', margin: '4px 0' }} />
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          placeholder="Archidekt deck URL (optional)"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          style={{ flex: 1 }}
        />
        <button disabled={busy || !url.trim()} onClick={() => void resolveUrl()}>Fetch</button>
      </div>
      <textarea
        placeholder={'…or paste a decklist:\n1 Sol Ring\n1x Arcane Signet\n// Commander\n1 Atraxa, Praetors’ Voice'}
        rows={10}
        value={text}
        onChange={(e) => setText(e.target.value)}
        style={{ fontFamily: 'monospace', fontSize: 13 }}
      />
      <div style={{ display: 'flex', gap: 10 }}>
        <button className="primary" disabled={busy || !text.trim()} onClick={() => void resolveText()}>
          {busy ? 'Working…' : 'Resolve decklist'}
        </button>
        {status && <span className="subtle" style={{ alignSelf: 'center' }}>{status}</span>}
      </div>
      {problems.length > 0 && (
        <div className="error" style={{ color: '#e0a578', fontSize: 13 }}>
          {problems.slice(0, 12).map((p, i) => (
            <div key={i}>⚠ {p}</div>
          ))}
          {problems.length > 12 && <div>…and {problems.length - 12} more</div>}
        </div>
      )}
      {pending && (
        <>
          {commanders.length > 0 ? (
            <div className="subtle">
              Commander{commanders.length > 1 ? 's' : ''}: {commanders.map((c) => c.sf?.name).join(', ')}
            </div>
          ) : (
            <div className="row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className="subtle">No commander detected — pick one (optional):</span>
              <select value={commanderPick ?? ''} onChange={(e) => setCommanderPick(e.target.value || null)}>
                <option value="">none</option>
                {uniqueNames.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button onClick={onClose}>Cancel</button>
            <button className="primary" onClick={doImport}>
              Choose this deck ({pending.length} cards) & shuffle up
            </button>
          </div>
        </>
      )}
    </Backdrop>
  );
}

// ---------------------------------------------------------------------------
// Opening hand: Keep / Mulligan with London-rule bottoming
// ---------------------------------------------------------------------------

type HandDest = 'keep' | 'bottom' | 'exile';
const DEST_LABEL: Record<Exclude<HandDest, 'keep'>, string> = {
  bottom: '→ bottom of library',
  exile: '→ exile',
};

/**
 * Archidekt-style opening hand: mulligan redraws 7; any number of cards
 * (including none) can be sent to the bottom or exile when keeping. The
 * London count is shown as a hint, never enforced (§1.1: players are smart).
 */
function OpeningHandModal({ onClose }: { onClose: () => void }) {
  const hand = useGame((s) => s.hidden.hand);
  const library = useGame((s) => s.hidden.library);
  const pool = useGame((s) => s.pool);
  const [mulligans, setMulligans] = useState(0);
  const [dests, setDests] = useState<Record<string, HandDest>>({});

  const setDest = (guid: string, dest: HandDest) => setDests((d) => ({ ...d, [guid]: dest }));

  const nBottom = hand.filter((g) => dests[g] === 'bottom').length;
  const nExile = hand.filter((g) => dests[g] === 'exile').length;

  const keep = () => {
    for (const guid of hand) {
      const dest = dests[guid] ?? 'keep';
      if (dest === 'bottom') actions.moveCard(guid, { zone: 'library', libPos: 'bottom' });
      else if (dest === 'exile') actions.moveCard(guid, { zone: 'exile' });
    }
    onClose();
  };

  return (
    <Backdrop onClose={onClose}>
      <h3>{mulligans === 0 ? 'Your opening hand' : `Mulligan #${mulligans} — keep this one?`}</h3>
      <div className="subtle">
        Right-click a card to bottom it or exile it.
        {mulligans > 0 && ` London rule suggests bottoming ${Math.min(mulligans, hand.length)} — your call.`}
      </div>
      <div className="card-grid">
        {hand.map((guid) => {
          const p = pool[guid];
          const dest = dests[guid] ?? 'keep';
          return (
            <div key={guid} className="gcard" style={{ cursor: 'context-menu' }}>
              <CardView
                pool={p}
                menuItems={[
                  { label: 'Keep', action: () => setDest(guid, 'keep') },
                  { label: 'To bottom of library', action: () => setDest(guid, 'bottom') },
                  { label: 'Exile', action: () => setDest(guid, 'exile') },
                ]}
                style={
                  dest === 'keep'
                    ? undefined
                    : {
                        outline: `3px solid ${dest === 'bottom' ? 'var(--warn)' : 'var(--danger)'}`,
                        borderRadius: 12,
                        opacity: 0.65,
                      }
                }
              />
              {dest !== 'keep' && (
                <div className="glabel" style={{ color: dest === 'bottom' ? 'var(--warn)' : 'var(--danger)' }}>
                  {DEST_LABEL[dest]}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', alignItems: 'center' }}>
        {/* Escape hatch: wrong deck entirely. Swapping re-deals and reopens
            this modal for the new hand. */}
        <button style={{ marginRight: 'auto' }} onClick={() => useUI.getState().openModal({ kind: 'import' })}>
          Change deck
        </button>
        <span className="subtle">
          {library.length} in library
          {nBottom > 0 && ` · bottoming ${nBottom}`}
          {nExile > 0 && ` · exiling ${nExile}`}
        </span>
        <button
          onClick={() => {
            actions.mulligan();
            setMulligans((n) => n + 1);
            setDests({});
          }}
        >
          Mulligan (draw 7 again)
        </button>
        <button className="primary" onClick={keep}>
          {nBottom + nExile > 0 ? `Keep ${hand.length - nBottom - nExile}` : 'Keep hand'}
        </button>
      </div>
    </Backdrop>
  );
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

function PrefsModal({ onClose }: { onClose: () => void }) {
  const prefs = useGame((s) => s.prefs);
  const setPrefs = useGame((s) => s.setPrefs);
  const session = useGame((s) => s.session);
  const pool = useGame((s) => s.pool);
  const seat = session?.seat ?? 0;
  const myColor = paletteColor(prefs.playerColor, seat);
  const hasCommander = Object.values(pool).some(
    (p) => p.ownerId === session?.playerId && p.commander
  );
  const matChoice = prefs.playmatStyle?.startsWith('url:')
    ? 'url'
    : prefs.playmatStyle ?? 'color';
  /** Color + playmat are shared identity — publish so the table sees them. */
  const publishIdentity = () => {
    if (session?.seat !== null && session?.seat !== undefined) actions.publishMyCounts();
  };
  return (
    <Backdrop onClose={onClose}>
      <h3>Preferences</h3>
      <div>
        <div style={{ marginBottom: 6 }}>
          My color <span className="subtle">(card rings, cursor, playmat — not a mana color)</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {PLAYER_PALETTE.map((c) => (
            <button
              key={c.name}
              className={`swatch${myColor.name === c.name ? ' picked' : ''}`}
              title={c.name}
              style={{ background: c.hex }}
              onClick={() => {
                setPrefs({ playerColor: c.name });
                publishIdentity();
              }}
            />
          ))}
        </div>
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        Playmat background
        <select
          value={matChoice}
          onChange={(e) => {
            const v = e.target.value;
            // The saved URL survives style switches, so coming back to
            // "custom" restores the last mat instead of asking again.
            setPrefs({ playmatStyle: v === 'url' ? `url:${prefs.playmatUrl ?? ''}` : v });
            publishIdentity();
          }}
        >
          <option value="color">My color's pattern</option>
          <option value="commander" disabled={!hasCommander}>
            My commander's art{hasCommander ? '' : ' (import a deck first)'}
          </option>
          <option value="url">Custom image URL…</option>
        </select>
      </label>
      {matChoice === 'url' && (
        <input
          autoFocus={!prefs.playmatUrl}
          placeholder="https://… (image URL for your playmat)"
          value={prefs.playmatUrl ?? (prefs.playmatStyle?.startsWith('url:') ? prefs.playmatStyle.slice(4) : '')}
          onChange={(e) => {
            const u = e.target.value;
            setPrefs({ playmatUrl: u, playmatStyle: `url:${u}` });
          }}
          onBlur={publishIdentity}
          onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
        />
      )}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={prefs.faceOpponentCards}
          onChange={(e) => setPrefs({ faceOpponentCards: e.target.checked })}
        />
        Rotate opponents' cards to face me (no upside-down reading)
      </label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={prefs.showHandToTable}
          onChange={(e) => actions.setShowHandToTable(e.target.checked)}
        />
        Teaching mode: continuously reveal my hand to the table
      </label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={prefs.shareCursor}
          onChange={(e) => setPrefs({ shareCursor: e.target.checked })}
        />
        Share my cursor position with the table (drags always share)
      </label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={prefs.hoverPreview}
          onChange={(e) => setPrefs({ hoverPreview: e.target.checked })}
        />
        Big card preview on hover
      </label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        Cursor/drag broadcast rate: {prefs.cursorRate}/s
        <input
          type="range"
          min={2}
          max={15}
          value={prefs.cursorRate}
          onChange={(e) => setPrefs({ cursorRate: Number(e.target.value) })}
        />
      </label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        Starting life
        <input
          type="number"
          style={{ width: 70 }}
          value={prefs.defaultLife}
          onChange={(e) => setPrefs({ defaultLife: Number(e.target.value) || 40 })}
        />
      </label>
      <div style={{ textAlign: 'right' }}>
        <button className="primary" onClick={onClose}>Done</button>
      </div>
    </Backdrop>
  );
}

// ---------------------------------------------------------------------------
// Switchboard
// ---------------------------------------------------------------------------

export function ModalHost() {
  const modal = useUI((s) => s.modal);
  const close = () => useUI.getState().closeModal();

  switch (modal.kind) {
    case 'peek':
      return <PeekModal count={modal.count} onClose={close} />;
    case 'search':
      return <SearchModal ownerId={modal.ownerId} onClose={close} />;
    case 'zone':
      return <ZoneModal zone={modal.zone} zoneOwnerId={modal.zoneOwnerId} onClose={close} />;
    case 'tokens':
      return <TokenModal at={modal.at} onClose={close} />;
    case 'import':
      return <ImportModal onClose={close} />;
    case 'prefs':
      return <PrefsModal onClose={close} />;
    case 'openingHand':
      return <OpeningHandModal onClose={close} />;
    case 'confirm':
      return (
        <Backdrop onClose={close}>
          <h3>{modal.title}</h3>
          <div>{modal.body}</div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button onClick={close}>Cancel</button>
            <button
              className="danger"
              onClick={() => {
                close();
                modal.onConfirm();
              }}
            >
              Yes, do it
            </button>
          </div>
        </Backdrop>
      );
    default:
      return null;
  }
}
