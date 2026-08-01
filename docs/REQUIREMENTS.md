# Playmat — Requirements

**Status:** Draft
**Last updated:** 2026-07-31

So what follows is AI-generated, except where I (the human) have annotated with parentheses. And the final section for ### Other thoughts. The human decisions override any AI design doc choices.

## 1. Overview

Playmat is a shared virtual table for paper-style Magic: The Gathering. Players load a decklist, join a room with a short code, and manipulate cards on a shared surface that syncs to everyone in the room in near real time.

Playmat does **not** implement the rules of Magic. It does not know what a legal play is, does not enforce priority or the stack, and does not check mana costs. It is the digital equivalent of a kitchen table: it holds cards where you put them, and the players sort out what is legal. This is a deliberate product decision, not a phase-one shortcut.

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
- Spectator Mode
- This is like a combination of the Archidekt/Moxfield playtester + a life tracking app on a phone where you can track life totals and commander damage (in particular, you can increment/decrement the commander damage total for a player, and it also ticks up/down on the life total. so you don't have to double track.)

### 2.2 Non-goals (v1)

- Rules enforcement, the stack, priority, triggered abilities, mana.
- Deck legality checking (format, singleton, color identity).
- Matchmaking, ladders, ratings, tournaments.
- Chat, voice, video. Players are assumed to be on Discord or in the same room.
- Mobile-first layout. Desktop/tablet is the target; phones are best-effort.
- Persistence of a game across days. A room is a session.

## 3. Users and context

**Primary:** A pod of two to four friends playing Commander or Pauper EDH remotely, already talking over voice. Geographically dispersed (the reference case is Maine ↔ Hawaii). Familiar with paper Magic; not looking for Arena.

**Secondary:** A solo player goldfishing a deck to test its curve and lines.

## 4. Functional requirements

### 4.1 Rooms

| ID | Requirement |
|---|---|
| R-1 | A player can create a room and receive a short code (4–6 characters, unambiguous alphabet — no `0`/`O`, `1`/`I`/`l`). |
| R-2 | A player can join an existing room by entering its code and choosing a display name. |
| R-3 | A room holds a maximum of 4 seated players. |
| R-4 | Rooms expire automatically after 24 hours of inactivity. (I'm not married to this. I guess I don't want rooms disappearing too quickly) |
| R-5 | Joining a room delivers a full snapshot of current board state before any live events are applied. |
| R-6 | A player who disconnects and rejoins within the room's lifetime resumes their seat and their hidden zones. |
| R-7 | No account, email, or password is required to create or join a room. |

### 4.2 Decks

| ID | Requirement |
|---|---|
| D-1 | A player can import a deck by pasting a plain decklist (`1 Lightning Bolt` / `1x Lightning Bolt`, one per line, optional `// Commander` or `SB:` style section markers). |
| D-2 | A player can import a deck from an Archidekt ~~or Moxfield URL~~ (Moxfield will block us). |
| D-3 | Card names resolve to card data and images via Scryfall. Ambiguous or unresolvable names are surfaced to the player for correction; import is not blocked by a single bad line. |
| D-4 | Double-faced, split, adventure, and flip cards resolve correctly and expose both faces. |
| D-5 | A player can designate one or more cards as commanders, placing them in the command zone at game start. (Ideally this is inferred from the dekclist or the deck URL - I'm afraid of too many options / making this complicated. Definitely this is not SOP. Hmm I guess worst case scenario, the player uses the Search deck feature and drags the card into the command zone. So no special handling there...) |
| D-6 | Resolved deck data is cached server-side so that re-importing a common decklist does not re-query Scryfall per card. (Ok let's talk about this later)|
| D-7 | ~~Basic lands and tokens can be added to the board from a searchable picker without being in the decklist.~~ (basic lands should be in the decklist. For tokens, we should support the predefined types like Food, Treasure, Clue. But I guess custom tokens too where you can write arbitrary text on it. Or arbitrary creatures. in a later phase we can try to infer predefined creature tokens, etc. Archideckt might just support that out of the box...) |

### 4.3 Zones

Supported zones, per player: **library, hand, battlefield, graveyard, exile, command zone**.

| ID | Requirement |
|---|---|
| Z-1 | Library is ordered and face-down. Its contents are visible only to its owner, and only via explicit actions (§4.4). |
| Z-2 | Hand is unordered from other players' perspective and hidden from them; only the card count is public. |
| Z-3 | Battlefield is a free-positioning surface. Each player has a nominal region, but cards may be placed anywhere (control changes, shared board effects). |
| Z-4 | Graveyard and exile are ordered, public, and expandable to a full list view. |
| Z-5 | Command zone is public and displays commander tax as a manual counter. |
| Z-6 | Any card can be moved to any zone of any player, including another player's library at a chosen position (top / bottom / Nth from top). |

Throwing this out there: In terms of implementation, for private actions, we just don't publish an event.

### 4.4 Card actions

| ID | Requirement |
|---|---|
| C-1 | Drag a card to a new position on the battlefield. |
| C-2 | Tap/untap a card (90° rotation); untap all as a single action. (this should work with multiselect) |
| C-3 | Flip a card face-down (as a morph/manifest) and back. |
| C-4 | Transform a double-faced card between its faces. |
| C-5 | Add, remove, and set arbitrary named counters on a card (+1/+1, loyalty, charge, custom label). |
| C-6 | ~~Attach a card to another card to represent an aura or equipment; attached cards move with their host.~~ (Hmm I'm not sure about this - I think maybe we should allow click and drag for an area select, then you can move things around in a group)|
| C-7 | Create token copies of a card, or create a token by searching Scryfall's token set. |
| C-8 | Peek at the top N cards of a library (owner only), reorder them, and return them to the top or bottom — covering scry, surveil, and tutoring. |
| C-9 | Shuffle a library. |
| C-10 | Reveal a card from a hidden zone to all players. |
| C-11 | Move a card between any two zones via drag or a context menu. |
| C-12 | Group-select multiple battlefield cards and move them together. |

### 4.5 Game state

| ID | Requirement |
|---|---|
| G-1 | Each player has a life total, adjustable by ±1 and ±5, and directly editable. |
| G-2 | Commander damage is tracked per opponent, per commander. |
| G-3 | Poison/energy/experience counters are tracked per player. |
| G-4 | A shared die roller and coin flipper produce results visible to all players. (YESS!!! I'm tempted to animate this with threejs physics simulation? Talk me out of it man, talk me out of it...) |
| G-5 | A turn indicator can be passed between players. It is decorative and enforces nothing. (although it should cause someone to untap, upkeep, draw...hmm I guess the player can do that themselves. I guess there should be a shortcut button for untap all, and maybe one for untap,upkeep,draw) |
| G-6 | An untyped, per-room event log records significant actions (zone changes, life changes, shuffles, reveals) for dispute resolution. (I'll have more on this later...) |
| G-7 | Any player can trigger "reset board" or "new game," which returns all cards to their owners' libraries and shuffles. (Hmmm definitely have a confirmation dialog though. At one point I was pondering if we need to designate an Admin player. Probably overkill right now.) |

### 4.6 Presence

| ID | Requirement |
|---|---|
| P-1 | Each seated player's connection status (connected / reconnecting / gone) is visible to the room. |
| P-2 | Other players' cursors are visible on the battlefield while they are dragging. |

## 5. Architecture

### 5.1 Components

| Component | Service | Notes |
|---|---|---|
| Frontend | S3 + CloudFront | Static React SPA. No SSR. |
| Realtime transport | AppSync Events API | WebSocket pub/sub, scale-to-zero. |
| Auth | Lambda authorizer (`AWS_LAMBDA` mode) | Verifies room-scoped JWT. |
| Room/session API | Lambda Function URL | Create room, join room, fetch snapshot, import deck. |
| Rules/validation | *None in v1* | Reserved: a Lambda data source on a second namespace. (Uhh...not sure what this means. Don't make resources you don't need) |
| State | DynamoDB | Rooms table, Board table, Card cache table. |
| Card data | Scryfall API | External; cached in DynamoDB. |
| User-Agent | Be curteous and set this. mtg-playmat/0.1 maybe? |

**Region:** `us-east-1`.

### 5.2 Channel design

| Namespace | Path | Handler | Persisted |
|---|---|---|---|
| `ephemeral` | `/game/{code}/ephemeral/*` | none | no |
| `state` | `/game/{code}/state/*` | DynamoDB data source | yes |
| `private` | `/game/{code}/private/{playerId}` | none | no |

- **`ephemeral`** carries in-flight drag positions and cursor movement. No data source is attached, so no DynamoDB write and no Lambda invocation occurs per event. This is the highest-volume channel and must remain the cheapest.
- **`state`** carries committed actions — drops, zone changes, taps, counters, life. Each publish persists to the Board table via an `onPublish` handler before fan-out.
- **`private`** carries per-player hidden information (library peeks, opening hands). Subscription is authorized only for the matching `playerId`. See §7.3.

(Human: So I don't see the point of a private channel. Why broadcast it all? handle it all client-side?
Also I don't think we need to persist this info to DDB at all. Pretty sure this can all live in browsers. Yeah I think everything lives in localstorage.
ephemeral - ok I do like having cursor movement. And drags. Let's rate limit it though and have the client smoohtly interpolate movement (there's probably something more sophisticated than linear interpolation we can do). Rate limiting is a native feature of appsync i think?
Is it worth making the distinction between state and ephemeral? I mean in some sense, yes, but i mean, does this amount to 2 separate appsync channels? Or is it fine?
)

### 5.3 Data model

**Rooms table** — PK `roomCode`. Holds seat assignments, player display names, creation timestamp, and a TTL attribute for automatic expiry.

**Board table** — PK `roomCode`, SK `cardId` for card items plus a `#meta` item for player-level state (life, counters, turn). Per-card items avoid contention when several players act at once and keep any single item well under the 400KB limit.

**Card cache table** — PK `cardName` (normalized). Stores the Scryfall payload subset needed for rendering, with a long TTL. Populated on first import of a given card.

### 5.4 Event semantics

AppSync Events provides **at-most-once delivery and does not guarantee ordering**. The application must therefore satisfy:

| ID | Requirement |
|---|---|
| E-1 | State events carry absolute values, never deltas. A card position event contains `{x, y}`, not `{dx, dy}`. A life event contains the resulting total, not the change. |
| E-2 | Every state event carries a monotonically increasing sequence number scoped to its subject (card or player). |
| E-3 | Clients discard any received event whose sequence number is less than or equal to the last seen value for that subject. |
| E-4 | Drag events on the `ephemeral` channel are throttled client-side to at most 15/sec. (Oh I see. client-side throttling. I'd say even 8/sec. Well make it adjustable at any rate) |
| E-5 | A drag terminates with exactly one unthrottled event on the `state` channel, which is the authoritative commit. |
| E-6 | On WebSocket reconnect, the client re-fetches a full snapshot rather than attempting to replay missed events. (Hmm ok that would explain why we would need DDB i suppose...) |
| E-7 | The dragging client renders its own card movement locally and immediately, without waiting for the echo. |

E-1 through E-3 together mean a dropped or reordered event is corrected by the next event for that subject rather than corrupting state. E-5 ensures the one event that must land is not the one thrown away by throttling.

## 6. Non-functional requirements

| ID | Requirement |
|---|---|
| N-1 | Perceived latency for the acting player is zero (local optimistic rendering). Cross-player latency target is under 200ms p95 for continental US pairs. |
| N-2 | Cost for a 4-player, 2-hour session is under $0.25. Idle cost for an unused deployment is under $1/month, excluding any custom domain. |
| N-3 | Cold start on room creation is under 3 seconds. |
| N-4 | A room survives any single player's disconnect without state loss. |
| N-5 | Supported browsers: current Chrome, Firefox, Safari, Edge. |
| N-6 | Scryfall usage must respect their rate limits and caching guidance; images must not be hot-linked at high volume. **Verify current policy before implementation.** |

## 7. Security

### 7.1 Authorization model

1. A player calls the Room Lambda with a room code and display name. (we should persist the display name in Localstorage)
2. The Lambda validates the room exists and has a free seat, then mints a JWT containing `{roomCode, playerId, seat}`, signed with a key held in Secrets Manager. (Hmmm i don't love maintaining a secret. Is there another option? Maybe if the room is full, the new player just joins as a spectator? Idk I think we're overthinking this jwt thing...although this whole thing is a vanity project anyway, so might as well go full hog?)
3. The client connects to AppSync Events with that JWT.
4. The Lambda authorizer verifies the signature and confirms the requested channel path begins with `/game/{roomCode-from-claims}`. It returns `isAuthorized` plus `handlerContext: {playerId, roomCode}`. (how many lambdas do we have?)
5. Handlers read `$ctx.identity.handlerContext.playerId` to attribute events.

**Channel-path authorization is not declarative in AppSync Events.** Granting subscribe on `/game/*` grants it on every room. Scoping to a single room must be checked explicitly in the authorizer.

### 7.2 Requirements

| ID | Requirement |
|---|---|
| S-1 | No credential capable of accessing any room may be present in the CDN-served bundle. |
| S-2 | A room token grants access to exactly one room and expires with that room. |
| S-3 | A player may only publish events attributed to their own `playerId`. |
| S-4 | Display names are sanitized before rendering (XSS). |
| S-5 | Room creation is rate-limited per source IP. (What form will this take? Is this an out of the box feature?) |

### 7.3 Hidden information — accepted limitation

Hand and library contents are delivered to their owner over the `private` channel, and other players are not subscribed to it. This prevents accidental disclosure — a player cannot see an opponent's hand through the UI, and the browser of a non-owner never receives those cards.

It does **not** prevent a determined cheat. A player can inspect their own library order via devtools even without a UI affordance for it, and there is no server-side enforcement that a drawn card is the actual top card, because there is no rules engine to define what "the top card" means for a given action.

This is consistent with §1.1.3: Playmat is for playing with people you know, and offers exactly the protection a physical table does, which is to say the protection of not wanting to cheat. Any product decision to serve strangers requires revisiting this.

(As i said, i don't think it makes sense to have a private channel)

## 8. Deployment

### 8.1 Stacks

Single CDK stack for v1, containing AppSync, both Lambdas, all DynamoDB tables, the S3 bucket, and the CloudFront distribution.

(Ignore this next section, we're gonna one-shot it)
~~~
## 9. Milestones

| Milestone | Contents |
|---|---|
| **M1 — Sync spike** | Two browsers, one room, colored rectangles draggable and synced. No cards, no auth, API key only. Validates transport, cost model, and cross-country latency. |
| **M2 — Cards** | Decklist paste, Scryfall resolution, card rendering, library/hand/battlefield, draw, play, tap. |
| **M3 — Full table** | All zones, counters, tokens, life, commander damage, event log. |
| **M4 — Rooms and auth** | Room codes, JWT authorizer, private channels, reconnect and snapshot recovery, TTL cleanup. |
| **M5 — Polish** | Deckbuilder URL import, group select, attachments, die roller, presence cursors. |

M1 exists to fail cheaply. If AppSync latency or cost behaves unexpectedly across that distance, the transport decision should change before any Magic-specific work is built on top of it.
~~~

### Other thoughts
Ok so here are my thoughts. When the decklist is first imported, each card gets assigned a guid (in particular, 27 forests causes 27 different guids). Then when we shuffle a deck (library) we shuffle the guids. When someone takes a card from their library to the battlefield, we publish an event {guid:'...', action:...}

I'm thinking events are sorta like PUT /{guid} $state
So $state could be moving to a certain zone, or dragging, flipping, or whatever. The idea is idempotence.

I guess some operations would be like DELETE /{guid} - that would be the case for tokens. So you can also PUT to make a token.

Anyway, the decklist resolves to a list of CardData objects (more on that later), each assigned a guid. This is a nice immutable thing, so we broadcast it to all players. Then we can just refer to cards by guid for the rest of the game to keep bandwidth usage low. Also we should save the decklist to localhost...? Idk I'm thinking just that i kinda want to be able to come back another time and it remembers the deck I used before.

We want to use [mtg-crucible](https://www.npmjs.com/package/mtg-crucible) for displaying cards. It is a rendering engine (like render to png), but we want to use it for the React component it has for rendering to HTML (this is kinda the whole justification for this project...). Speaking of which, our SPA must be React. That will work with Cloudfront CDN right? Anyway, crucible has a browser build which I think we should use for this. It also has a CardData data structure. We can massage the scryfall card definition data to this format. Although we might actually want the RenderedCardInfo thingy which I think wraps CardData. But anyway, that is how you use the MtgCard react component. Crucible also will compute rotations for flip cards and battles (TODO verify this is a standalone function, and we don't have to call the renderCard function in order to receive the rotations). MtgCard renders a nice little spinner you can push to rotate the card. One edge case - crucible will always insert the null rotation as the first thing in the rotation array. For battles we probably want to strip this out - we want them to be turned sideways by default.


Emulate basically all the functionality in the Archidekt playtester. Like peak library, play with top revealed, search library, etc. Also it has a cool thing where if you add +1/+1 counters to a creature, it will calculate the effective P/T for you. We should be able to do that since we will have P/T from CardData (with some edge cases where it's */* instead of numeric. But what can you do?)

So there is sort of a tension where the Playmat view I see is different from what another player sees. Because obviously you want your own cards right in front of you. We resolve this by defining a fixed coordinate system that favors player one, and all published events use this convention, and then when we display on the client, we apply a rotation/transformation/otherwise affine thing as the last step to put your cards in front of you. I guess it's still weird since on top of this global transformation, we want to rotate just your own cards so they are facing you. I think we should wrap each MtgCard component in a <div> and apply a rotation to the div. We don't want to interfere with Crucible's native rotation system. I am also thinking maybe you should set a preference where opponent's cards are also rotated to match your orientation so you don't have to read upside down.

Regardless, I'm thinking there should be a feature to hover your mouse over a card and it produces a high quality, expanded version of the card for easy reading. Not sure how to make that not annoying and constantly misfiring.

Scryfall api looksup - ok so we should use scryfall images to stick into the MtgCard component for the img urls. I don't think there is any problem with that. To get that though, I think we have to look up the cards via the api. And as mentioned before, they want a courtesy of 10/second.

Looks like there is a bulk download. We should save this to s3 and decompress it. I guess our lambda could read the whole 200mb uncompressed thing, and resolve the decklists? I wonder how fast it would be. It would bloat our lambda memory reqs considerably. I really don't want to load this into memcached or something though of course. Another idea I had - maybe build an index mapping card-name to byte-range of the big file (since it's jsonl) and then use s3 byte indexes? Although that's 100 s3 lookups, ick. Our best bet might be to just hammer scryfall with the on demand api. 10 seconds for a deck ain't so bad?
https://scryfall.com/docs/api/bulk-data/
https://data.scryfall.io/oracle-cards/oracle-cards-20260731210300.jsonl.gz

Bells and whistles - I think the background image for this kitchen table thing could be cool. Archideckt has a pretty mundane black background with little gridlines. We could try to do a funny Medieval/fantasy hewn stone kitchen table surface. Could also make it respect the North/South/East/West orientations as an extra flourish. Check /Users/nathandunn/Projects/big-bad-wolf-trailer/.env for a REPLICATE_API_KEY you can use for generating images.

No need for a custom domain name yet.