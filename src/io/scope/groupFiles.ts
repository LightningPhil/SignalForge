import type { ImportSource } from '../adapters/types';
import { detectScopeFile } from './detect';
import { ScopeImportError } from './types';

export interface ScopeSourceGroup {
  primary: ImportSource;
  companions: ImportSource[];
  consumedNames: string[];
}

export interface ScopeGroupingFailure {
  error: ScopeImportError;
  sources: ImportSource[];
}

export interface ScopeGroupingResult {
  groups: ScopeSourceGroup[];
  /** Files that could not be grouped (orphan or ambiguous R&S halves). They are never importable. */
  failures: ScopeGroupingFailure[];
}

/**
 * Groups R&S description/payload pairs (case-insensitive stem match, strictly one-to-one) and leaves
 * every other file as its own group. Pairing problems are reported per stem so unrelated files in the
 * same selection stay importable.
 */
export function groupScopeSourcesWithFailures(sources: ImportSource[]): ScopeGroupingResult {
  const consumed = new Set<number>();
  const groups: ScopeSourceGroup[] = [];
  const failures: ScopeGroupingFailure[] = [];
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
    const members = [...pair.descriptions, ...pair.payloads];
    const names = members.map(({ source }) => source.name);
    members.forEach(({ index }) => consumed.add(index));
    if (pair.descriptions.length === 0 || pair.payloads.length === 0) {
      failures.push({
        error: new ScopeImportError(
          'missing-companion',
          `R&S waveform "${stem}" requires exactly one description .bin and one .Wfm.bin payload.`,
          { format: 'rohde-schwarz-rtx-bin', fileNames: names }
        ),
        sources: members.map(({ source }) => source)
      });
      continue;
    }
    if (pair.descriptions.length !== 1 || pair.payloads.length !== 1) {
      failures.push({
        error: new ScopeImportError(
          'ambiguous-companion',
          `R&S waveform "${stem}" has ${pair.descriptions.length} descriptions and ${pair.payloads.length} payloads.`,
          { format: 'rohde-schwarz-rtx-bin', fileNames: names }
        ),
        sources: members.map(({ source }) => source)
      });
      continue;
    }
    groups.push({
      primary: pair.descriptions[0].source,
      companions: [pair.payloads[0].source],
      consumedNames: [pair.descriptions[0].source.name, pair.payloads[0].source.name]
    });
  }

  for (let index = 0; index < sources.length; index += 1) {
    if (consumed.has(index)) continue;
    const primary = sources[index];
    consumed.add(index);
    groups.push({ primary, companions: [], consumedNames: [primary.name] });
  }
  return { groups, failures };
}

/** Strict variant: the first grouping failure is thrown. */
export function groupScopeSources(sources: ImportSource[]): ScopeSourceGroup[] {
  const { groups, failures } = groupScopeSourcesWithFailures(sources);
  if (failures.length > 0) throw failures[0].error;
  return groups;
}
