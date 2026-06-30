import { readFileSync } from 'fs';
import { resolve } from 'path';

import { parseXml } from '../src/utils';

function getFixture(name) {
  const path = resolve(import.meta.dirname, `fixtures/${name}`);
  return readFileSync(path, 'utf8');
}

describe('parseXml', () => {
  it('handles simple xml', () => {
    const xml = getFixture('copy-response.xml');
    const data = parseXml(xml);

    expect(data).toEqual({
      CopyObjectResult: {
        LastModified: '2009-10-12T17:50:30.000Z',
        ETag: '"9b2cf535f27731c974343645a3985328"',
      },
    });
  });

  it('handles lists', () => {
    const xml = getFixture('list-response.xml');
    const data = parseXml(xml);

    expect(data).toEqual({
      ListBucketResult: {
        Name: 'bucket',
        Prefix: '',
        MaxKeys: '1000',
        IsTruncated: 'false',
        Marker: '',
        Contents: [
          {
            Key: 'file1.jpg',
            LastModified: '2026-06-16T22:14:34.000Z',
            Size: '26702',
            StorageClass: 'STANDARD',
            Owner: {
              DisplayName: 'user',
              ID: 'user',
            },
          },
          {
            Key: 'file2.mp4',
            LastModified: '2026-06-16T22:21:26.000Z',
            Size: '3217865',
            StorageClass: 'STANDARD',
            Owner: {
              DisplayName: 'user',
              ID: 'user',
            },
          },
          {
            Key: 'file3.jpg',
            LastModified: '2026-06-18T15:24:31.000Z',
            Size: '56481',
            StorageClass: 'STANDARD',
            Owner: {
              DisplayName: 'user',
              ID: 'user',
            },
          },
        ],
      },
    });
  });

  it('handles self-closing tags', () => {
    const xml = getFixture('versions-response.xml');
    const data = parseXml(xml);

    expect(data).toEqual({
      ListVersionsResult: {
        Name: 'bucket',
        Prefix: '',
        MaxKeys: '1000',
        IsTruncated: 'false',
        KeyMarker: '',
        VersionIdMarker: '',
        Version: [
          {
            Key: 'file1.jpg',
            IsLatest: 'true',
            VersionId: '1781648073.939709',
            LastModified: '2026-06-16T22:14:34.000Z',
            Size: '26702',
            StorageClass: 'STANDARD',
            Owner: {
              DisplayName: 'user',
              ID: 'user',
            },
          },
          {
            Key: 'file2.mp4',
            IsLatest: 'true',
            VersionId: '1781648486.233691',
            LastModified: '2026-06-16T22:21:26.000Z',
            Size: '3217865',
            StorageClass: 'STANDARD',
            Owner: {
              DisplayName: 'user',
              ID: 'user',
            },
          },
        ],
      },
    });
  });
});

// parseXml is a deliberately tiny, NON-validating parser for the small XML
// subset S3 emits. It NEVER throws: malformed input degrades to best-effort
// (an unmatched region is returned verbatim as text). These suites pin that
// contract so the regex (which had a ReDoS rewrite) can't silently regress.

describe('parseXml — leaf & text handling', () => {
  it('returns "" for empty input', () => {
    expect(parseXml('')).toBe('');
  });

  it('returns plain text unchanged for a non-tag input', () => {
    expect(parseXml('hello world')).toBe('hello world');
  });

  it('decodes XML entities in leaf text', () => {
    expect(parseXml('1 &amp; 2 &lt;x&gt; &quot;q&quot; &apos;a&apos;')).toBe('1 & 2 <x> "q" \'a\'');
  });

  it('trims surrounding whitespace from leaf text', () => {
    expect(parseXml('<a>  x  </a>')).toEqual({ a: 'x' });
  });

  it('treats an empty element as an empty string', () => {
    expect(parseXml('<a></a>')).toEqual({ a: '' });
  });

  it('treats a whitespace-only element as an empty string', () => {
    expect(parseXml('<a>   </a>')).toEqual({ a: '' });
  });

  it('keeps numeric and boolean-looking values as strings (no coercion)', () => {
    expect(parseXml('<n>123</n>')).toEqual({ n: '123' });
    expect(parseXml('<b>false</b>')).toEqual({ b: 'false' });
  });

  it('preserves unicode and astral characters', () => {
    expect(parseXml('<a>café ☃ 𝟙</a>')).toEqual({ a: 'café ☃ 𝟙' });
  });
});

describe('parseXml — structure', () => {
  it('strips the XML declaration', () => {
    expect(parseXml('<?xml version="1.0" encoding="UTF-8"?><a>x</a>')).toEqual({ a: 'x' });
  });

  it('ignores attributes on open tags', () => {
    expect(parseXml('<a id="1" class="x">v</a>')).toEqual({ a: 'v' });
  });

  it('parses all three self-closing forms as empty strings', () => {
    expect(parseXml('<a/>')).toEqual({ a: '' });
    expect(parseXml('<a />')).toEqual({ a: '' });
    expect(parseXml('<a b="1" c="2"/>')).toEqual({ a: '' });
  });

  it('keeps a self-closing marker between siblings as "" without dropping the following tags', () => {
    // Regression for the original regex (no self-closing branch): it skipped
    // <b/> AND could swallow the next sibling. S3 emits exactly this shape —
    // empty <Prefix/>, <KeyMarker/>, <VersionIdMarker/> markers between elements.
    expect(parseXml('<r><a>1</a><b/><c>3</c></r>')).toEqual({ r: { a: '1', b: '', c: '3' } });
  });

  it('nests different-named children', () => {
    expect(parseXml('<a><b>x</b></a>')).toEqual({ a: { b: 'x' } });
  });

  it('handles deep nesting', () => {
    expect(parseXml('<a><b><c><d>x</d></c></b></a>')).toEqual({ a: { b: { c: { d: 'x' } } } });
  });

  it('ignores insignificant whitespace between sibling tags (multiline)', () => {
    expect(parseXml('<a>\n  <b>x</b>\n  <c>y</c>\n</a>')).toEqual({ a: { b: 'x', c: 'y' } });
  });

  it('keeps a single occurrence as a scalar, not an array', () => {
    expect(parseXml('<r><i>1</i></r>')).toEqual({ r: { i: '1' } });
  });

  it('promotes repeated tags to an array (in document order)', () => {
    expect(parseXml('<r><i>1</i><i>2</i><i>3</i></r>')).toEqual({ r: { i: ['1', '2', '3'] } });
  });
});

describe('parseXml — real S3 response shapes', () => {
  it('parses an <Error> response', () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message>' +
      '<Key>missing.txt</Key><RequestId>0A1B2C3D</RequestId></Error>';
    expect(parseXml(xml)).toEqual({
      Error: {
        Code: 'NoSuchKey',
        Message: 'The specified key does not exist.',
        Key: 'missing.txt',
        RequestId: '0A1B2C3D',
      },
    });
  });

  it('represents a single <Contents> as an object, not an array (S3 single-vs-array quirk)', () => {
    // A one-object listing has no array; multiple <Contents> → array is covered
    // by the list-response.xml fixture above. Consumers must handle both.
    const xml =
      '<ListBucketResult><Name>bucket</Name>' +
      '<Contents><Key>only.txt</Key><Size>1</Size></Contents></ListBucketResult>';
    const r = parseXml(xml);
    expect(Array.isArray(r.ListBucketResult.Contents)).toBe(false);
    expect(r.ListBucketResult.Contents).toEqual({ Key: 'only.txt', Size: '1' });
  });

  it('decodes XML entities inside leaf elements (object keys with "&", "<", ">")', () => {
    expect(parseXml('<Key>a &amp; b &lt;c&gt;.txt</Key>')).toEqual({ Key: 'a & b <c>.txt' });
  });
});

describe('parseXml — tag name edge cases', () => {
  it('accepts a leading underscore', () => {
    expect(parseXml('<_x>v</_x>')).toEqual({ _x: 'v' });
  });

  it('accepts dots, dashes, and digits after the first char', () => {
    expect(parseXml('<a.b-c1>v</a.b-c1>')).toEqual({ 'a.b-c1': 'v' });
  });

  it('does NOT treat a digit-leading name as a tag (invalid XML name → text)', () => {
    // XML names cannot start with a digit, so this is malformed; returned verbatim.
    expect(parseXml('<1bad>v</1bad>')).toBe('<1bad>v</1bad>');
  });
});

describe('parseXml — malformed input is lenient (never throws)', () => {
  const malformed = ['<a>oops', '<a>x</b>', 'a < b', '<>', '</a>', '<a><b></a>'];

  it.each(malformed)('does not throw on %p', input => {
    expect(() => parseXml(input)).not.toThrow();
  });

  it('returns an unclosed tag verbatim as text', () => {
    expect(parseXml('<a>oops')).toBe('<a>oops');
  });

  it('returns mismatched open/close tags verbatim (backreference fails)', () => {
    expect(parseXml('<a>x</b>')).toBe('<a>x</b>');
  });

  it('returns a stray "<" surrounded by spaces verbatim', () => {
    expect(parseXml('a < b')).toBe('a < b');
  });
});

describe('parseXml — known limitations (regex subset, not full XML)', () => {
  // S3 never emits these shapes; documented here so any future behavior change
  // is an intentional, reviewed decision rather than a silent regression.

  it('cannot recurse same-named nesting (lazy backref stops at first close)', () => {
    expect(parseXml('<a><a>x</a></a>')).toEqual({ a: '<a>x' });
  });

  it('drops loose text in mixed content, keeping only child tags', () => {
    expect(parseXml('<a>text<b>x</b></a>')).toEqual({ a: { b: 'x' } });
  });

  it('does not strip comments', () => {
    expect(parseXml('<a><!-- c -->x</a>')).toEqual({ a: '<!-- c -->x' });
  });

  it('does not unwrap CDATA sections', () => {
    expect(parseXml('<a><![CDATA[<b>raw]]></a>')).toEqual({ a: '<![CDATA[<b>raw]]>' });
  });

  it('mis-parses a ">" inside an attribute value', () => {
    expect(parseXml('<a b="x>y">z</a>')).toEqual({ a: 'y">z' });
  });
});

describe('parseXml — no super-linear backtracking (ReDoS regression guard)', () => {
  // SonarCloud (S5852) flagged two earlier regexes for super-linear runtime.
  // Measured: on those regexes the match attempt at offset 0 backtracks O(n²)
  // for the inputs below; the current (linear) regex parses each 100k-char input
  // in <1ms. Reintroducing overlapping unbounded quantifiers makes the elapsed
  // time explode and fails this guard. (Verified empirically against all three
  // historical patterns before these inputs were chosen.)
  const N = 100_000;
  const cases = [
    // tag-name run, never terminated: `[\w\-.]*` vs the trailing `[^>]*?` overlap.
    // O(n²) on BOTH the original `…[^>]*?>…` and the `…|\s*\/>` regexes.
    { label: 'unterminated tag-name run', input: '<' + 'a'.repeat(N) },
    // whitespace run with no '>'/'/>': `[^>]*?` vs the `\s*` in `…|\s*\/>` overlap.
    // O(n²) on the intermediate regex — the exact shape Sonar reported.
    { label: 'whitespace run before a non-terminator', input: '<a' + ' '.repeat(N) + 'x' },
  ];

  it.each(cases)('parses an $label (100k chars) in linear time', ({ input }) => {
    const start = performance.now();
    const result = parseXml(input);
    const elapsed = performance.now() - start;
    expect(result).toBeDefined();
    expect(elapsed).toBeLessThan(1000);
  });

  it('parses thousands of repeated siblings in linear time', () => {
    const xml = '<r>' + '<i>x</i>'.repeat(5000) + '</r>';
    const start = performance.now();
    const result = parseXml(xml);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(Array.isArray(result.r.i)).toBe(true);
    expect(result.r.i).toHaveLength(5000);
  });
});
