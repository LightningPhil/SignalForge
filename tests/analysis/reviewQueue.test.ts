import { describe, expect, it } from 'vitest';
import {
  classifyShotForReview,
  collectShotReviewWarnings,
  filterShotsForReview,
  navigateReviewQueue,
  summarizeReviewQueue
} from '../../src/analysis/reviewQueue';
import {
  createAnnotation,
  createShot,
  type ReviewStatus,
  type SessionAnalysisResult,
  type Shot,
  type SourceFileRecord
} from '../../src/domain/session';

function shot(name: string, reviewStatus: ReviewStatus): Shot {
  const created = createShot(name);
  created.reviewStatus = reviewStatus;
  return created;
}

function sourceWithWarnings(warnings: string[]): SourceFileRecord {
  return {
    id: 'source',
    name: 'capture.csv',
    size: 0,
    lastModified: null,
    adapterId: 'csv',
    metadata: {},
    warnings
  };
}

function resultWithWarnings(warnings: string[]): SessionAnalysisResult {
  return {
    id: 'result',
    type: 'pulse-power',
    values: {},
    units: {},
    provenance: {
      sourceChannelIds: [],
      processingRecipeHash: 'recipe',
      annotationIds: [],
      warnings,
      applicationVersion: 'test',
      createdAt: '2026-01-01T00:00:00.000Z'
    }
  };
}

describe('review queue classification', () => {
  it('collects every persisted warning source and pending suggestion without mutating the shot', () => {
    const candidate = shot('Warning-bearing', 'accepted');
    candidate.metadata.appendWarning = '  append projection warning  ';
    candidate.sourceFiles.push(sourceWithWarnings(['source import warning', '   ']));
    candidate.analysisResults.push(resultWithWarnings(['result provenance warning']));
    candidate.annotations.push(
      createAnnotation('pending', 0, { source: 'suggested', suggestionState: 'pending' }),
      createAnnotation('accepted', 0, { source: 'suggested', suggestionState: 'accepted' }),
      createAnnotation('rejected', 0, { source: 'suggested', suggestionState: 'rejected' })
    );

    expect(collectShotReviewWarnings(candidate)).toEqual([
      'append projection warning',
      'source import warning',
      'result provenance warning'
    ]);
    expect(classifyShotForReview(candidate)).toEqual({
      needsReview: true,
      hasWarnings: true,
      excluded: false,
      warnings: ['append projection warning', 'source import warning', 'result provenance warning'],
      pendingSuggestionCount: 1
    });
    expect(candidate.metadata.appendWarning).toBe('  append projection warning  ');
    expect(candidate.sourceFiles[0].warnings).toEqual(['source import warning', '   ']);
  });

  it('uses review status while treating exclusion as authoritative', () => {
    expect(classifyShotForReview(shot('New', 'unreviewed')).needsReview).toBe(true);
    expect(classifyShotForReview(shot('Started', 'in-progress')).needsReview).toBe(true);
    expect(classifyShotForReview(shot('Done', 'accepted')).needsReview).toBe(false);

    const excluded = shot('Excluded', 'excluded');
    excluded.metadata.appendWarning = 'still visible under the warning filter';
    excluded.annotations.push(createAnnotation('pending', 0, { source: 'suggested' }));
    expect(classifyShotForReview(excluded)).toMatchObject({
      needsReview: false,
      hasWarnings: true,
      excluded: true,
      pendingSuggestionCount: 1
    });
  });
});

describe('review queue filters and navigation', () => {
  function fixture(): Shot[] {
    const complete = shot('Complete', 'accepted');
    const incomplete = shot('Incomplete', 'unreviewed');
    const warning = shot('Warning', 'accepted');
    warning.analysisResults.push(resultWithWarnings(['check calculation']));
    const pending = shot('Pending', 'accepted');
    pending.annotations.push(createAnnotation('edge', 0, { source: 'suggested' }));
    const excluded = shot('Excluded', 'excluded');
    excluded.sourceFiles.push(sourceWithWarnings(['known import issue']));
    return [complete, incomplete, warning, pending, excluded];
  }

  it('filters in stable shot order and summarizes overlapping classifications', () => {
    const shots = fixture();
    const originalOrder = shots.map((candidate) => candidate.id);

    expect(filterShotsForReview(shots).map((candidate) => candidate.name)).toEqual([
      'Incomplete',
      'Warning',
      'Pending'
    ]);
    expect(filterShotsForReview(shots, 'warnings').map((candidate) => candidate.name)).toEqual(['Warning', 'Excluded']);
    expect(filterShotsForReview(shots, 'excluded').map((candidate) => candidate.name)).toEqual(['Excluded']);
    expect(filterShotsForReview(shots, 'all')).toEqual(shots);
    expect(summarizeReviewQueue(shots)).toEqual({
      total: 5,
      accepted: 3,
      inProgress: 0,
      unreviewed: 1,
      needsReview: 3,
      warnings: 2,
      excluded: 1
    });
    expect(shots.map((candidate) => candidate.id)).toEqual(originalOrder);
  });

  it('moves to the nearest eligible shot and wraps in both directions', () => {
    const shots = fixture();
    const [, incomplete, warning, pending] = shots;

    expect(navigateReviewQueue(shots, incomplete.id, 1)?.id).toBe(warning.id);
    expect(navigateReviewQueue(shots, pending.id, 1)?.id).toBe(incomplete.id);
    expect(navigateReviewQueue(shots, incomplete.id, -1)?.id).toBe(pending.id);
    expect(navigateReviewQueue(shots, shots[0].id, 1)?.id).toBe(incomplete.id);
    expect(navigateReviewQueue(shots, shots[0].id, -1)?.id).toBe(pending.id);
    expect(navigateReviewQueue(shots, null, 1)?.id).toBe(incomplete.id);
    expect(navigateReviewQueue(shots, 'not-present', -1)?.id).toBe(pending.id);
  });

  it('returns null for an empty filter and returns the sole item after wrapping', () => {
    const complete = shot('Complete', 'accepted');
    expect(navigateReviewQueue([complete], complete.id, 1)).toBeNull();

    complete.metadata.appendWarning = 'review me';
    expect(navigateReviewQueue([complete], complete.id, 1, 'warnings')).toBe(complete);
    expect(navigateReviewQueue([complete], complete.id, -1, 'warnings')).toBe(complete);
  });
});
