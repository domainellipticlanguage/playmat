# Playmat — Requirements

**Status:** Living document — originally drafted before implementation, since updated to fold in the decisions made along the way.
**Last updated:** 2026-08-03

## 1. Overview

Playmat is a shared virtual table for paper-style Magic: The Gathering. Players load a decklist, join a room with a short code, and manipulate cards on a shared surface that syncs to everyone in the room in near real time.

Playmat does **not** implement the rules of Magic. It does not know what a legal play is, does not enforce priority or the stack, and does not check mana costs. It is the digital equivalent of a kitchen table: it holds cards where you put them, and the players sort out what is legal. This is a deliberate product decision, not a phase-one shortcut.

Showcasing [mtg-crucible](https://www.npmjs.com/package/mtg-crucible)'s `MtgCard` React component is part of the project's purpose: every card face on the table is crucible-rendered.

### 1.1 Design principles

1. **The table is dumb, the players are smart.** Anything requiring judgment belongs to the players.
2. **Positions are approximate.** Cards land where dropped; no grid snapping is required for correctness.
3. **Trust-based.** Playmat is for playing with people you know. It resists accidents, not adversaries. See §7.3.
4. **Scale to zero.** An idle Playmat costs approximately nothing.

## 2. Goals and non-goals

### 2.1 Goals

- Two to four players share a board state with sub-200ms perceived sync.
- Load a deck from a decklist or a deckbuilder URL in under 30 seconds.
- Support the full set of Magic zones, including the command zone (Commander/PDH is the primary format).
- Work in a browser with no install, no account, and no app store.
- Cost under $5/month at hobby usage.
- Spectator mode: a full room still admits watchers.
- Fold the phone-app life tracker into the table: life, commander damage, poison/energy/experience live on the same screen as the cards, and commander damage ticks the life total automatically — no double tracking.

### 2.2 Non-goals (v1)

- Rules enforcement, the stack, priority, triggered abilities, mana.
- Deck legality checking (format, singleton, color identity).
- Matchmaking, ladders, ratings, tournaments.
- Chat, voice, video. Players are assumed to be on Discord or in the same room.
- A native mobile app. (The browser app itself grew real phone support after v1 — see N-7; desktop remains the primary target.)
- Persistence of a game across days. A room is a session.

## 3. Users and context

**Primary:** A pod of two to four friends playing Commander or Pauper EDH remotely, already talking over voice. Geographically dispersed (the reference case is Maine ↔ Hawaii). Familiar with paper Magic; not looking for Arena.

**Secondary:** A solo player goldfishing a deck to test its curve and lines.

## 4. Functional requirements

### 4.1 Rooms

| ID | Requirement |
|---|---|
| R-1 | A player can create a room and receive a short code (4–6 characters, unambiguous alphabet — no `0`/`O`, `1`/`I`/`l`). |
| R-2 | A player can join an existing room by entering its code and choosing a display name. Code input accepts pasted invite URLs. |
| R-3 | A room holds a maximum of 4 seated players; further joiners become spectators. |
| R-4 | Rooms expire automatically after a day-plus of inactivity (TTL-driven; err toward keeping rooms longer rather than shorter). |
| R-5 | Joining a room delivers a full snapshot of current board state before any live events are applied. |
| R-6 | A player who disconnects and rejoins within the room's lifetime resumes their seat and their hidden zones. |
| R-7 | No account, email, or password is required to create or join a room. Display names persist in localStorage. |

### 4.2 Decks

| ID | Requirement |
|---|---|
| D-1 | A player can import a deck by pasting a plain decklist (`1 Lightning Bolt` / `1x Lightning Bolt`, one per line, optional `// Commander` or `SB:` style section markers). |
| D-2 | A player can import a deck from an Archidekt URL. (Moxfield blocks third-party fetches, so it is out.) An import that resolves cleanly becomes the chosen deck without a confirmation step. |
| D-3 | Card names resolve to card data and images via Scryfall, client-side through `/cards/collection` (75 cards per request). Ambiguous or unresolvable names are surfaced to the player for correction; import is not blocked by a single bad line. |
| D-4 | Double-faced, split, adventure, flip, and battle cards resolve correctly and expose all faces and rotations. |
| D-5 | Commanders are inferred from the decklist or deck URL (`// Commander`, `*CMDR*`, Archidekt's Commander category), with a manual pick as fallback; they start in the command zone. |
| D-6 | Resolved decks are saved in the browser (with their real deck names and commander art) for one-click re-use in later sessions. There is no server-side card cache; Scryfall resolution is cheap enough per import. |
| D-7 | Basic lands belong in the decklist. Tokens do not: predefined quick picks (Food, Treasure, Clue, …), Scryfall token search, and fully custom tokens (arbitrary name, text, P/T) are all creatable at the table. Custom tokens are rendered by crucible on every client from synced JSON. Copying a card as a token produces a token-framed copy, and any token leaving the battlefield ceases to exist. |

### 4.3 Zones

Supported zones, per player: **library, hand, battlefield, graveyard, exile, command zone**.

| ID | Requirement |
|---|---|
| Z-1 | Library is ordered and rendered face-down, but its order is published to the table so any player can browse, search, and pull from any library — the same reach they have over a graveyard. See §7.3 for the honor-system trade this accepts. |
| Z-2 | Hand is unordered from other players' perspective and hidden from them; only the card count is public. Exception: teaching mode (C-13). |
| Z-3 | Battlefield is a free-positioning surface. Each player has a nominal region, but cards may be placed anywhere (control changes, shared board effects). |
| Z-4 | Graveyard and exile are ordered, public, and expandable to a full list view. |
| Z-5 | Command zone is public and displays commander tax as a manual counter (doubling it gives the cost bump). |
| Z-6 | A card only ever occupies **its own owner's** library, hand, graveyard, exile, and command zone. Milling or discarding another player's card puts it in *their* zone; nothing of yours can end up in their deck. The battlefield is the sole exception — `controllerId` lets you take control of an opponent's permanent. A drop onto another player's pile is refused rather than silently rerouted. |
| Z-7 | Reordering a library (shuffle, scry, peek) stays with its owner: only the owner's client holds the authoritative array, so another player searching a library leaves the shuffle to them. |

Private actions are private by construction: nothing about them is published at all, rather than published-and-hidden.

### 4.4 Card actions

| ID | Requirement |
|---|---|
| C-1 | Drag a card to a new position on the battlefield. |
| C-2 | Tap/untap a card (90° rotation), including a whole multi-selection at once; untap all as a single action. |
| C-3 | Flip a card face-down (as a morph/manifest) and back. |
| C-4 | Transform a double-faced card between its faces. |
| C-5 | Add, remove, and set arbitrary named counters on a card (+1/+1, loyalty, charge, custom label). +1/+1 counters display the effective P/T. |
| C-6 | No attach/host mechanic: multi-select and group drag (C-12) cover moving auras and equipment with their creature. |
| C-7 | Create token copies of a card, or create a token by searching Scryfall's token set (see D-7). |
| C-8 | Peek at the top N cards of a library (owner only — reordering is owner-only per Z-7), reorder them, and return them to the top or bottom — covering scry, surveil, and tutoring. |
| C-9 | Shuffle a library (owner only, Z-7). |
| C-10 | Reveal a card from a hidden zone to all players. |
| C-11 | Move a card between any two zones via drag or a context menu, subject to Z-6. Right-click offers a context menu on every surface: cards, hand, piles, library, battlefield background. |
| C-12 | Group-select multiple battlefield cards (shift+click) and move them together. |
| C-13 | Teaching mode: a player may continuously reveal their hand to the table. While it is on, **other players may act on that hand** — play, discard, exile, or tuck a card on the owner's behalf. Every such move still resolves into the owner's own zones (Z-6). |
| C-14 | Hovering a card shows a high-quality expanded preview for easy reading; suppressed while dragging so it never fights the interaction. |

### 4.5 Game state

| ID | Requirement |
|---|---|
| G-1 | Each player has a life total, adjustable by ±1 and ±5, and directly editable. |
| G-2 | Commander damage is tracked per opponent, per commander, and ticks the life total. |
| G-3 | Poison/energy/experience counters are tracked per player. |
| G-4 | A shared die roller (d6/d20/dN) and coin flipper produce results visible to all players, with a synced animation. (CSS animation — a physics engine is not worth the dependency.) |
| G-5 | A turn indicator is decorative and enforces nothing. Taking the turn is a free-for-all — any player may take it at any time, and there is deliberately no pass-the-turn button. A take-turn shortcut does untap-all + draw for whoever takes it. |
| G-6 | An untyped, per-room event log records significant actions (zone changes, life changes, shuffles, reveals) for dispute resolution. |
| G-7 | Any player can trigger "reset board" or "new game," behind a confirmation dialog. No admin role exists or is needed. |

### 4.6 Presence

| ID | Requirement |
|---|---|
| P-1 | Each seated player's connection status (connected / reconnecting / gone) is visible in their tray. |
| P-2 | Other players' cursors are visible on the battlefield while they are dragging. |

### 4.7 Orientation

Published coordinates use one fixed table-space convention. Each client applies its own per-seat view transform as a final display step, so every player sees their own cards nearest themselves. Per-card upright rotation is applied on a wrapper div — never through crucible's own rotation system, which stays reserved for card-intrinsic states (tap, transform, battles). A preference optionally counter-rotates opponents' cards so nobody reads upside down.

## 5. Architecture

### 5.1 Components

| Component | Service | Notes |
|---|---|---|
| Frontend | S3 + CloudFront | Static React SPA. No SSR. |
| Card rendering | mtg-crucible (browser build) | `MtgCard` for every face; `computeRotations` for flip/battle states; client-side `renderCard` for custom tokens. |
| Realtime transport | AppSync Events API | WebSocket pub/sub, scale-to-zero. |
| Auth | Lambda authorizer (`AWS_LAMBDA` mode) | Verifies room-scoped JWT. |
| Room/session API | Lambda Function URL | Create room, join room, fetch snapshot. |
| State | DynamoDB | Rooms table + Board table, both TTL-cleaned. |
| Card data | Scryfall API | Client-side resolution; courteous User-Agent; respect rate limits. |

Two Lambdas total (room API, authorizer). **Region:** `us-east-1`.

### 5.2 Channel design

| Namespace | Path | Handler | Persisted |
|---|---|---|---|
| `ephemeral` | `/ephemeral/{code}` | none | no |
| `state` | `/state/{code}` | DynamoDB data source | yes |

The namespace must be the first path segment in AppSync Events, hence `/state/{code}` rather than a `/game/{code}/...` shape.

- **`ephemeral`** carries in-flight drag positions and cursor movement, throttled client-side (E-4) and smoothed by interpolation on receipt. No data source is attached, so no DynamoDB write and no Lambda invocation occurs per event. This is the highest-volume channel and must remain the cheapest.
- **`state`** carries committed actions — drops, zone changes, taps, counters, life. Each publish persists to the Board table via an `onPublish` handler *before* fan-out, so reconnect is always "fetch snapshot, then apply live events," never event replay.
- There is **no private channel.** Hidden information (library order, hand) lives in the owner's browser and localStorage, persisted server-side only inside the owner's snapshot for reconnect (R-6). Broadcasting-then-hiding was rejected outright.

### 5.3 Data model

**Rooms table** — PK `roomCode`. Holds seat assignments, player display names, creation timestamp, and a TTL attribute for automatic expiry.

**Board table** — PK `roomCode`, SK per subject (one item per card/player, 72h TTL). Per-subject items avoid contention when several players act at once and keep any single item well under the 400KB limit. "New game" mints a fresh `gameId` and old-epoch items simply fall out of snapshots — no mass deletes.

### 5.4 Event semantics

AppSync Events provides **at-most-once delivery and does not guarantee ordering**. The application must therefore satisfy:

| ID | Requirement |
|---|---|
| E-1 | State events carry absolute values, never deltas. A card position event contains `{x, y}`, not `{dx, dy}`. A life event contains the resulting total, not the change. Events are idempotent PUTs keyed by card guid (token deletion being the one DELETE). |
| E-2 | Every state event carries a monotonically increasing sequence number scoped to its subject (card or player). |
| E-3 | Clients discard any received event whose sequence number is less than or equal to the last seen value for that subject; ties break deterministically by publisher id. |
| E-4 | Drag events on the `ephemeral` channel are throttled client-side — default 8/sec, adjustable in preferences. |
| E-5 | A drag terminates with exactly one unthrottled event on the `state` channel, which is the authoritative commit. |
| E-6 | On WebSocket reconnect, the client re-fetches a full snapshot rather than attempting to replay missed events. |
| E-7 | The dragging client renders its own card movement locally and immediately, without waiting for the echo. |

E-1 through E-3 together mean a dropped or reordered event is corrected by the next event for that subject rather than corrupting state. E-5 ensures the one event that must land is not the one thrown away by throttling.

Every physical card gets a guid at import — 27 Forests produce 27 guids. The resolved pool (guid → card data) is broadcast once and persisted; afterwards all events refer to guids only, keeping per-event bandwidth small. A deck re-import mints an `importId` that atomically replaces the player's pool.

## 6. Non-functional requirements

| ID | Requirement |
|---|---|
| N-1 | Perceived latency for the acting player is zero (local optimistic rendering). Cross-player latency target is under 200ms p95 for continental US pairs. |
| N-2 | Cost for a 4-player, 2-hour session is under $0.25. Idle cost for an unused deployment is under $1/month, excluding any custom domain. |
| N-3 | Cold start on room creation is under 3 seconds. |
| N-4 | A room survives any single player's disconnect without state loss. |
| N-5 | Supported browsers: current Chrome, Firefox, Safari, Edge. |
| N-6 | Scryfall usage must respect their rate limits and caching guidance; images must not be hot-linked at high volume. |
| N-7 | **Desktop/mobile parity for interactions.** Anything draggable with a mouse is draggable by touch — one Pointer-Events code path, with `touch-action: none` on every drag surface so the browser never claims the gesture. The layout fits a phone viewport exactly (no page scroll in either axis); trays collapse to stat lines and the hand takes the full bottom edge. |

## 7. Security

### 7.1 Authorization model

1. A player calls the Room Lambda with a room code and display name.
2. The Lambda validates the room exists, then mints a JWT containing `{roomCode, playerId, seat}` (seat `null` for spectators when the room is full). The HS256 signing key is generated at first synth and kept with the stack — no Secrets Manager; this is a trust-based hobby deployment, and the key never enters the repo or the bundle.
3. The client connects to AppSync Events with that JWT.
4. The Lambda authorizer verifies the signature and confirms the requested channel path belongs to the room in the claims. It returns `isAuthorized` plus `handlerContext: {playerId, roomCode}`.
5. Handlers read the handler context to attribute events.

**Channel-path authorization is not declarative in AppSync Events.** Granting subscribe on a wildcard grants it on every room; scoping to a single room must be checked explicitly in the authorizer.

### 7.2 Requirements

| ID | Requirement |
|---|---|
| S-1 | No credential capable of accessing any room may be present in the CDN-served bundle. |
| S-2 | A room token grants access to exactly one room and expires with that room. |
| S-3 | A player may only publish events attributed to their own `playerId`. |
| S-4 | Display names are sanitized before rendering (XSS). |
| S-5 | Room creation is rate-limited per source IP. |

### 7.3 Hidden information — accepted limitation

**Hand** contents stay with their owner: peers receive only `handCount`, plus any card individually revealed (C-10) or the whole hand under teaching mode (C-13).

**Library** contents are deliberately *not* hidden. Each player's library order ships on their `PlayerState`, so every client holds every deck's exact order (Z-1). This buys interaction parity — a library can be browsed, searched, and pulled from exactly like a graveyard, instead of being the one zone on another player's board you cannot touch. The cost is real and worth stating plainly: **a player who goes looking can see their own next draw.** The UI never shows you your own library order except through explicit actions (search, scry, peek), but nothing stops devtools.

It does **not** prevent a determined cheat, and after the Z-1 change it does not even prevent a casual one. There is also no server-side enforcement that a drawn card is the actual top card, because there is no rules engine to define what "the top card" means for a given action.

This is consistent with §1.1.3: Playmat is for playing with people you know, and offers exactly the protection a physical table does, which is to say the protection of not wanting to cheat. Any product decision to serve strangers requires revisiting this.

## 8. Deployment

Single CDK stack (`Playmat`) containing AppSync, both Lambdas, both DynamoDB tables, the S3 bucket, and the CloudFront distribution. `scripts/deploy.mjs` runs the whole pipeline: CDK deploy → fresh web build with the stack's real endpoints injected → S3 sync → CloudFront invalidation. No custom domain yet.

## 9. Presentation

The table itself is part of the product: a generated wood table surface (`scripts/gen-art.mjs`), per-seat playmat regions in each player's color (or their commander's art, or a custom image), and a charcoal-and-gold UI. Player colors are deliberately non-mana colors so they never read as a mana identity.
