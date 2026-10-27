import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const entryPoints = [
  '@yaniv120892/observability',
  '@yaniv120892/observability/node',
  '@yaniv120892/observability/next',
];

/** Runs outside any bundler, the way a vitest run or a tsx script in a consumer loads the package. */
function loadInPlainNode({
  entryPoint,
  moduleSystem,
}: {
  entryPoint: string;
  moduleSystem: string;
}) {
  const source =
    moduleSystem === 'commonjs'
      ? `require(${JSON.stringify(entryPoint)});`
      : `await import(${JSON.stringify(entryPoint)});`;
  return spawnSync(process.execPath, ['--input-type', moduleSystem, '-e', source], {
    encoding: 'utf8',
  });
}

describe('built entry points', () => {
  for (const entryPoint of entryPoints) {
    for (const moduleSystem of ['module', 'commonjs']) {
      it(`load ${entryPoint} as ${moduleSystem} without a bundler`, () => {
        const result = loadInPlainNode({ entryPoint, moduleSystem });
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
      });
    }
  }
});
