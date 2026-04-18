import { describe, test, expect } from 'bun:test';
import { extractContractManifest, extractBackpressureCommands } from '../ralph/unit-file.ts';

describe('extractContractManifest', () => {
  test('returns missing when no Contract Manifest heading exists', () => {
    const md = `# Unit 1\n\n### Backpressure\n- \`bun test\`\n`;
    const result = extractContractManifest(md);
    expect(result.kind).toBe('missing');
  });

  test('parses a well-formed manifest with named/type/default exports', () => {
    const md = `# Unit 1

### Contract Manifest

\`\`\`json
{
  "exports": [
    { "symbol": "Foo", "module": "src/foo.ts", "kind": "named" },
    { "symbol": "BarT", "module": "src/types.ts", "kind": "type" },
    { "symbol": "DefaultThing", "module": "src/default.ts", "kind": "default" }
  ],
  "consumes": [
    { "symbol": "Existing", "from": "src/existing.ts" }
  ]
}
\`\`\`
`;
    const result = extractContractManifest(md);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.manifest.exports).toHaveLength(3);
    expect(result.manifest.exports[0]).toEqual({ symbol: 'Foo', module: 'src/foo.ts', kind: 'named' });
    expect(result.manifest.exports[1].kind).toBe('type');
    expect(result.manifest.exports[2].kind).toBe('default');
    expect(result.manifest.consumes).toHaveLength(1);
    expect(result.manifest.consumes[0]).toEqual({ symbol: 'Existing', from: 'src/existing.ts' });
  });

  test('defaults exports[].kind to "named" when omitted', () => {
    const md = `### Contract Manifest

\`\`\`json
{ "exports": [{ "symbol": "X", "module": "src/x.ts" }], "consumes": [] }
\`\`\`
`;
    const result = extractContractManifest(md);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.manifest.exports[0].kind).toBe('named');
  });

  test('accepts empty exports[] and consumes[]', () => {
    const md = `### Contract Manifest

\`\`\`json
{ "exports": [], "consumes": [] }
\`\`\`
`;
    const result = extractContractManifest(md);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.manifest.exports).toEqual([]);
    expect(result.manifest.consumes).toEqual([]);
  });

  test('rejects missing exports[] array', () => {
    const md = `### Contract Manifest

\`\`\`json
{ "consumes": [] }
\`\`\`
`;
    const result = extractContractManifest(md);
    expect(result.kind).toBe('malformed');
    if (result.kind !== 'malformed') return;
    expect(result.error).toContain('exports');
  });

  test('rejects missing consumes[] array', () => {
    const md = `### Contract Manifest

\`\`\`json
{ "exports": [] }
\`\`\`
`;
    const result = extractContractManifest(md);
    expect(result.kind).toBe('malformed');
    if (result.kind !== 'malformed') return;
    expect(result.error).toContain('consumes');
  });

  test('rejects invalid kind value', () => {
    const md = `### Contract Manifest

\`\`\`json
{ "exports": [{ "symbol": "X", "module": "src/x.ts", "kind": "wrong" }], "consumes": [] }
\`\`\`
`;
    const result = extractContractManifest(md);
    expect(result.kind).toBe('malformed');
    if (result.kind !== 'malformed') return;
    expect(result.error).toContain('kind');
  });

  test('rejects malformed JSON', () => {
    const md = `### Contract Manifest

\`\`\`json
{ "exports": [
\`\`\`
`;
    const result = extractContractManifest(md);
    expect(result.kind).toBe('malformed');
    if (result.kind !== 'malformed') return;
    expect(result.error).toContain('JSON parse failed');
  });

  test('reports error when heading present but no json fence found', () => {
    const md = `### Contract Manifest

Some prose, no fenced block.

### Next Section
`;
    const result = extractContractManifest(md);
    expect(result.kind).toBe('malformed');
    if (result.kind !== 'malformed') return;
    expect(result.error).toContain('json');
  });

  test('only reads the json fence inside the manifest section, not later sections', () => {
    const md = `### Contract Manifest

(no fence here)

### Test Stubs

\`\`\`json
{ "this": "should not be parsed" }
\`\`\`
`;
    const result = extractContractManifest(md);
    expect(result.kind).toBe('malformed');
  });

  test('rejects array (non-object) at top level', () => {
    const md = `### Contract Manifest

\`\`\`json
[]
\`\`\`
`;
    const result = extractContractManifest(md);
    expect(result.kind).toBe('malformed');
  });

  test('rejects exports entry with empty symbol', () => {
    const md = `### Contract Manifest

\`\`\`json
{ "exports": [{ "symbol": "", "module": "src/x.ts" }], "consumes": [] }
\`\`\`
`;
    const result = extractContractManifest(md);
    expect(result.kind).toBe('malformed');
    if (result.kind !== 'malformed') return;
    expect(result.error).toContain('symbol');
  });

  test('matches both ## and ### heading levels', () => {
    const mdH2 = `## Contract Manifest

\`\`\`json
{ "exports": [], "consumes": [] }
\`\`\`
`;
    expect(extractContractManifest(mdH2).kind).toBe('ok');
  });
});

describe('extractBackpressureCommands', () => {
  test('returns commands from inline code spans', () => {
    const md = `## Backpressure\n- \`bun test foo\`\n- \`bun run typecheck\`\n`;
    expect(extractBackpressureCommands(md)).toEqual(['bun test foo', 'bun run typecheck']);
  });

  test('returns empty array when no Backpressure heading', () => {
    expect(extractBackpressureCommands('# Unit 1\n')).toEqual([]);
  });
});
