import type { ImportSource } from '../adapters/types';
import { detectScopeFile } from './detect';
import { ScopeImportError } from './types';

export interface ScopeSourceGroup {
  primary: ImportSource;
  companions: ImportSource[];
  consumedNames: string[];
}

export function groupScopeSources(sources: ImportSource[]): ScopeSourceGroup[] {
  const consumed = new Set<number>();
  const groups: ScopeSourceGroup[] = [];
  const pairs = new Map<
    string,
    {
      descriptions: Array<{ source: ImportSource; index: number }>;
      payloads: Array<{ source: ImportSource; index: number }>;
    }
  >();

  sources.forEach((source, index) => {
    const format = detectScopeFile(source)?.format;
    if (format !== 'rohde-schwarz-rtx-bin' && format !== 'rohde-schwarz-wfm-bin-payload') return;
    const stem = source.name
      .replace(/\.wfm\.bin$/i, '')
      .replace(/\.bin$/i, '')
      .toLowerCase();
    const pair = pairs.get(stem) || { descriptions: [], payloads: [] };
    (format === 'rohde-schwarz-rtx-bin' ? pair.descriptions : pair.payloads).push({ source, index });
    pairs.set(stem, pair);
  });

  for (const [stem, pair] of pairs) {
    const names = [...pair.descriptions, ...pair.payloads].map(({ source }) => source.name);
    if (pair.descriptions.length === 0 || pair.payloads.length === 0) {
      throw new ScopeImportError(
        'missing-companion',
        `R&S waveform "${stem}" requires exactly one description .bin and one .Wfm.bin payload.`,
        { format: 'rohde-schwarz-rtx-bin', fileNames: names }
      );
    }
    if (pair.descriptions.length !== 1 || pair.payloads.length !== 1) {
      throw new ScopeImportError(
        'ambiguous-companion',
        `R&S waveform "${stem}" has ${pair.descriptions.length} descriptions and ${pair.payloads.length} payloads.`,
        { format: 'rohde-schwarz-rtx-bin', fileNames: names }
      );
    }
    consumed.add(pair.descriptions[0].index);
    consumed.add(pair.payloads[0].index);
    groups.push({
      primary: pair.descriptions[0].source,
      companions: [pair.payloads[0].source],
      consumedNames: [pair.descriptions[0].source.name, pair.payloads[0].source.name]
    });
  }

  for (let index = 0; index < sources.length; index += 1) {
    if (consumed.has(index)) continue;
    const primary = sources[index];
    const detected = detectScopeFile(primary);
    if (detected?.format === 'rohde-schwarz-wfm-bin-payload' || detected?.format === 'rohde-schwarz-rtx-bin') continue;
    consumed.add(index);
    groups.push({ primary, companions: [], consumedNames: [primary.name] });
  }
  return groups;
}
