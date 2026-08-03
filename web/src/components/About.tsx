/**
 * The #about page. Hash-routed from the lobby (see App), so the browser's
 * back arrow returns there and the URL is bookmarkable.
 */
export function About() {
  return (
    <div className="lobby about">
      <h1>
        <a href="#">
          <img src="/logo.svg" alt="Playmat" style={{ width: 'min(280px, 70vw)', display: 'block' }} />
        </a>
      </h1>
      <div className="card">
        <p>
          Playmat is a shared kitchen table for paper-style Magic: The Gathering. Create a room,
          share the five-letter code, and push cards around a table that stays in sync for everyone
          sitting at it. There's no rules engine and there are no accounts — the table is dumb; the
          players are smart.
        </p>

        <div className="credit">
          <img src="/crucible.svg" alt="mtg-crucible logo" />
          <div>
            <h2>mtg-crucible</h2>
            <div className="credit-tag">The card renderer that powers this table</div>
            <p>
              An open-source TypeScript library for rendering Magic: The Gathering cards. Every
              face on this table is its <code>MtgCard</code> component, custom tokens are drawn
              in-browser by its render engine on every client (only JSON crosses the wire), and
              flip, transform, and battle orientations come from its <code>computeRotations</code>.
              Try the renderer on its own at the{' '}
              <a href="https://domainellipticlanguage.com/project/mtg-crucible-playground/" target="_blank" rel="noreferrer">
                playground
              </a>
              .
            </p>
            <div className="credit-links">
              <span>
                GitHub:{' '}
                <a href="https://github.com/domainellipticlanguage/mtg-crucible" target="_blank" rel="noreferrer">
                  domainellipticlanguage/mtg-crucible
                </a>
              </span>
              <span>
                npm:{' '}
                <a href="https://www.npmjs.com/package/mtg-crucible" target="_blank" rel="noreferrer">
                  mtg-crucible
                </a>
              </span>
            </div>
          </div>
        </div>

        <p>
          Card data and imagery are provided by{' '}
          <a href="https://scryfall.com" target="_blank" rel="noreferrer">
            Scryfall
          </a>
          . Playmat is unofficial Fan Content permitted under Wizards of the Coast's Fan Content
          Policy; Magic: The Gathering and all card names and images are property of Wizards of the
          Coast. Playmat is not produced by or endorsed by Wizards of the Coast or Scryfall.
        </p>
        <p>
          The code lives at{' '}
          <a href="https://github.com/domainellipticlanguage/playmat" target="_blank" rel="noreferrer">
            github.com/domainellipticlanguage/playmat
          </a>
          , design doc included.
        </p>
        <div className="row">
          <a className="back" href="#">
            ← Back to the lobby
          </a>
        </div>
      </div>
    </div>
  );
}
