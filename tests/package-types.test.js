'use strict';

import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// moduleResolution "node" (Node10) ignores `exports`; resolving the package dir walks package.json `types`/`main` exactly like a node_modules lookup does.
test('types resolve for consumers on moduleResolution node10', () => {
  const { resolvedModule } = ts.resolveModuleName(
    root,
    `${root}consumer.ts`,
    { moduleResolution: ts.ModuleResolutionKind.Node10 },
    ts.sys,
  );
  expect(resolvedModule?.resolvedFileName).toBe(`${root}dist/index.d.mts`);
});
