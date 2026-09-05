import { describe, expect, it } from 'vitest';
import { archidektDeckApiUrl, archidektProxyError } from './archidektProxy';

const EDGE_403_HTML =
  '<!doctype html><meta charset="utf-8"><meta name=viewport content="width=device-width, initial-scale=1"><title>403</title>403 Forbidden';

describe('archidektDeckApiUrl', () => {
  it('keeps only digits and adds the trailing slash Archidekt wants', () => {
    expect(archidektDeckApiUrl('19478743')).toBe('https://archidekt.com/api/decks/19478743/');
    expect(archidektDeckApiUrl('19478743abc/../x')).toBe('https://archidekt.com/api/decks/19478743/');
  });
});

describe('archidektProxyError', () => {
  it('reports an edge (HTML) 403 with no detail — the cloud-IP block', () => {
    expect(archidektProxyError(403, 'text/html; charset=utf-8', EDGE_403_HTML)).toEqual({
      error: 'archidekt_upstream',
      upstreamStatus: 403,
    });
  });

  it("surfaces Archidekt's own JSON detail (e.g. a private deck)", () => {
    const body = JSON.stringify({ detail: 'You do not have permission to perform this action.' });
    expect(archidektProxyError(403, 'application/json', body)).toEqual({
      error: 'archidekt_upstream',
      upstreamStatus: 403,
      detail: 'You do not have permission to perform this action.',
    });
  });

  it('tolerates a JSON content-type with an unparsable or detail-less body', () => {
    expect(archidektProxyError(404, 'application/json', '{"nope":1}')).toEqual({
      error: 'archidekt_upstream',
      upstreamStatus: 404,
    });
    expect(archidektProxyError(502, 'application/json', '<html>bad gateway</html>')).toEqual({
      error: 'archidekt_upstream',
      upstreamStatus: 502,
    });
    expect(archidektProxyError(500, null, '')).toEqual({ error: 'archidekt_upstream', upstreamStatus: 500 });
  });
});
