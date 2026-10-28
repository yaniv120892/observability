import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const entryPoints = [
  {
    entryPoint: '@yaniv120892/observability',
    expectedExports: [
      'createLogger',
      'checkLiveness',
      'createDeepHealthCheck',
      'withholdPrismaMessages',
    ],
    isFrameworkFree: true,
  },
  {
    entryPoint: '@yaniv120892/observability/node',
    expectedExports: ['createNodeObservability', 'withholdPrismaMessages'],
    isFrameworkFree: true,
  },
  {
    entryPoint: '@yaniv120892/observability/next',
    expectedExports: ['createNextObservability', 'withholdPrismaMessages'],
    isFrameworkFree: false,
  },
  {
    entryPoint: '@yaniv120892/observability/next/sentry',
    expectedExports: ['initSentry', 'withholdPrismaMessages'],
    isFrameworkFree: false,
  },
];

/** Fails the load the moment anything asks for Next or its Sentry SDK, as if neither were installed. */
const WITHOUT_NEXT = `
process.getBuiltinModule('node:module').registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^(next|@sentry\\/nextjs)(\\/|$)/.test(specifier)) {
      throw new Error('Cannot find package ' + specifier);
    }
    return nextResolve(specifier, context);
  },
});
`;

/**
 * Runs the built package outside any bundler, the way a vitest run, a tsx script, or a CommonJS
 * app compiled by tsc loads it, and checks the named exports arrive.
 */
function loadInPlainNode({
  entryPoint,
  moduleSystem,
  expectedExports,
  withoutNext = false,
}: {
  entryPoint: string;
  moduleSystem: string;
  expectedExports: string[];
  withoutNext?: boolean;
}) {
  const load =
    moduleSystem === 'commonjs'
      ? `const loaded = require(${JSON.stringify(entryPoint)});`
      : `const loaded = await import(${JSON.stringify(entryPoint)});`;
  const check = `
for (const name of ${JSON.stringify(expectedExports)}) {
  if (typeof loaded[name] !== 'function') {
    throw new Error(name + ' is not exported');
  }
}`;
  const source = [withoutNext ? WITHOUT_NEXT : '', load, check].join('\n');
  return spawnSync(process.execPath, ['--input-type', moduleSystem, '-e', source], {
    encoding: 'utf8',
  });
}

describe('built entry points', () => {
  for (const { entryPoint, expectedExports } of entryPoints) {
    for (const moduleSystem of ['module', 'commonjs']) {
      it(`load ${entryPoint} as ${moduleSystem} without a bundler`, () => {
        const result = loadInPlainNode({ entryPoint, moduleSystem, expectedExports });
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
      });
    }
  }

  for (const { entryPoint, expectedExports } of entryPoints.filter(
    ({ isFrameworkFree }) => isFrameworkFree,
  )) {
    for (const moduleSystem of ['module', 'commonjs']) {
      it(`load ${entryPoint} as ${moduleSystem} with Next absent`, () => {
        const result = loadInPlainNode({
          entryPoint,
          moduleSystem,
          expectedExports,
          withoutNext: true,
        });
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
      });
    }
  }

  it('fails to load the Next entry with Next absent, so that check bites', () => {
    const result = loadInPlainNode({
      entryPoint: '@yaniv120892/observability/next',
      moduleSystem: 'commonjs',
      expectedExports: [],
      withoutNext: true,
    });
    expect(result.stderr).toContain('Cannot find package');
  });
});
