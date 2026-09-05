import type { Shot } from '../domain/session';

export type ReviewQueueFilter = 'needs-review' | 'warnings' | 'excluded' | 'all';

export interface ShotReviewClassification {
  needsReview: boolean;
  hasWarnings: boolean;
  excluded: boolean;
  warnings: string[];
  pendingSuggestionCount: number;
}

export interface ReviewQueueSummary {
  total: number;
  accepted: number;
  inProgress: number;
  unreviewed: number;
  needsReview: number;
  warnings: number;
  excluded: number;
}

function nonEmptyWarnings(warnings: readonly string[]): string[] {
  return warnings.map((warning) => warning.trim()).filter(Boolean);
}

export function collectShotReviewWarnings(shot: Shot): string[] {
  const appendWarning =
    typeof shot.metadata.appendWarning === 'string' ? nonEmptyWarnings([shot.metadata.appendWarning]) : [];
  const sourceWarnings = shot.sourceFiles.flatMap((source) => nonEmptyWarnings(source.warnings));
  const resultWarnings = shot.analysisResults.flatMap((result) => nonEmptyWarnings(result.provenance.warnings));
  return [...appendWarning, ...sourceWarnings, ...resultWarnings];
}

export function classifyShotForReview(shot: Shot): ShotReviewClassification {
  const warnings = collectShotReviewWarnings(shot);
  const pendingSuggestionCount = shot.annotations.filter(
    (annotation) => annotation.source === 'suggested' && annotation.suggestionState === 'pending'
  ).length;
  const excluded = shot.reviewStatus === 'excluded';
  const incomplete = shot.reviewStatus === 'unreviewed' || shot.reviewStatus === 'in-progress';

  return {
    needsReview: !excluded && (incomplete || warnings.length > 0 || pendingSuggestionCount > 0),
    hasWarnings: warnings.length > 0,
    excluded,
    warnings,
    pendingSuggestionCount
  };
}

export function filterShotsForReview(shots: readonly Shot[], filter: ReviewQueueFilter = 'needs-review'): Shot[] {
  if (filter === 'all') return shots.slice();
  return shots.filter((shot) => {
    const classification = classifyShotForReview(shot);
    if (filter === 'warnings') return classification.hasWarnings;
    if (filter === 'excluded') return classification.excluded;
    return classification.needsReview;
  });
}

export function summarizeReviewQueue(shots: readonly Shot[]): ReviewQueueSummary {
  const summary: ReviewQueueSummary = {
    total: shots.length,
    accepted: 0,
    inProgress: 0,
    unreviewed: 0,
    needsReview: 0,
    warnings: 0,
    excluded: 0
  };
  for (const shot of shots) {
    if (shot.reviewStatus === 'accepted') summary.accepted += 1;
    if (shot.reviewStatus === 'in-progress') summary.inProgress += 1;
    if (shot.reviewStatus === 'unreviewed') summary.unreviewed += 1;
    const classification = classifyShotForReview(shot);
    if (classification.needsReview) summary.needsReview += 1;
    if (classification.hasWarnings) summary.warnings += 1;
    if (classification.excluded) summary.excluded += 1;
  }
  return summary;
}

export function navigateReviewQueue(
  shots: readonly Shot[],
  currentShotId: string | null,
  direction: -1 | 1,
  filter: ReviewQueueFilter = 'needs-review'
): Shot | null {
  const queue = filterShotsForReview(shots, filter);
  if (queue.length === 0) return null;

  const step = direction < 0 ? -1 : 1;
  const currentIndex = currentShotId === null ? -1 : shots.findIndex((shot) => shot.id === currentShotId);
  if (currentIndex < 0) return step < 0 ? queue[queue.length - 1] : queue[0];

  const eligibleIds = new Set(queue.map((shot) => shot.id));
  for (let offset = 1; offset <= shots.length; offset += 1) {
    const index = (currentIndex + step * offset + shots.length) % shots.length;
    const candidate = shots[index];
    if (eligibleIds.has(candidate.id)) return candidate;
  }
  return null;
}
