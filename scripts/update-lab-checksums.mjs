import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { checksumFloat64 } from '../tests/synthetic/lab.ts';
import { buildScenario, expectedScenarioChecksums, scenarioNames } from '../tests/synthetic/scenarios.ts';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const catalogPath = path.join(scriptDirectory, '..', 'tests', 'synthetic', 'scenarios.ts');
const checksums = Object.fromEntries(
  scenarioNames.map((name) => {
    const record = buildScenario(name);
    return [
      name,
      {
        timeChecksum: checksumFloat64(record.time),
        valueChecksum: checksumFloat64(record.values)
      }
    ];
  })
);

const changed = scenarioNames.filter(
  (name) =>
    expectedScenarioChecksums[name].timeChecksum !== checksums[name].timeChecksum ||
    expectedScenarioChecksums[name].valueChecksum !== checksums[name].valueChecksum
);

if (process.argv.includes('--write')) {
  const source = readFileSync(catalogPath, 'utf8');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = [
    '// LAB_CHECKSUMS_START',
    'export const expectedScenarioChecksums: Record<ScenarioName, { timeChecksum: string; valueChecksum: string }> = {',
    ...scenarioNames.map(
      (name, index) =>
        `  '${name}': { timeChecksum: '${checksums[name].timeChecksum}', valueChecksum: '${checksums[name].valueChecksum}' }${index + 1 === scenarioNames.length ? '' : ','}`
    ),
    '};',
    '// LAB_CHECKSUMS_END'
  ];
  const blockPattern = /\/\/ LAB_CHECKSUMS_START[\s\S]*?\/\/ LAB_CHECKSUMS_END/;
  if (!blockPattern.test(source)) {
    throw new Error('Checksum markers were not found in tests/synthetic/scenarios.ts.');
  }
  const updated = source.replace(blockPattern, lines.join(newline));
  if (updated !== source) writeFileSync(catalogPath, updated);
  console.log(
    changed.length === 0 ? 'Lab scenario checksums already match.' : `Updated ${changed.length} scenario checksum(s).`
  );
} else {
  console.log(JSON.stringify(checksums, null, 2));
  if (process.argv.includes('--check') && changed.length > 0) {
    console.error(`Lab checksum drift: ${changed.join(', ')}`);
    process.exitCode = 1;
  }
}
