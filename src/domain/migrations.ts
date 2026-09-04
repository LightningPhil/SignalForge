import type { Session } from './session';

export const CURRENT_SESSION_SCHEMA = 1;

function migrateVersionZero(input: Record<string, unknown>): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    ...input,
    metadata: input.metadata || {},
    importProfileId: input.importProfileId ?? null,
    processingRecipe: input.processingRecipe || {},
    shots: Array.isArray(input.shots) ? input.shots : [],
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
    schemaVersion: 1
  };
}

function requireString(value: unknown, field: string, maxLength = 500): string {
  const hasUnsafeControl =
    typeof value === 'string' && Array.from(value).some((character) => character.charCodeAt(0) < 9);
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || hasUnsafeControl) {
    throw new Error(`${field} must be a non-empty string no longer than ${maxLength} characters.`);
  }
  return value;
}

function requireId(value: unknown, field: string): string {
  const id = requireString(value, field, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) {
    throw new Error(`${field} contains unsafe characters.`);
  }
  return id;
}

function requireFinite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} must be finite.`);
  return value;
}

function requirePrimitiveRecord(value: unknown, field: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  for (const [key, entry] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new Error(`${field} contains a forbidden key.`);
    }
    if (!['string', 'number', 'boolean'].includes(typeof entry) && entry !== null && entry !== undefined) {
      throw new Error(`${field}.${key} must be a primitive value.`);
    }
    if (typeof entry === 'number' && !Number.isFinite(entry)) {
      throw new Error(`${field}.${key} must be finite.`);
    }
  }
}

function requireStringArray(value: unknown, field: string): void {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length > 2000)) {
    throw new Error(`${field} must be an array of bounded strings.`);
  }
}

function requireTokenRecord(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  for (const [index, token] of Object.entries(value)) {
    if (!/^(?:0|[1-9]\d*)$/.test(index) || (!['string', 'boolean'].includes(typeof token) && token !== null)) {
      throw new Error(`${field} contains an invalid sample token.`);
    }
  }
}

function requireSafeJson(value: unknown, field: string, depth = 0): void {
  if (depth > 20) throw new Error(`${field} exceeds the nesting limit.`);
  if (value === null || value === undefined || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (value.length > 1_000_000) throw new Error(`${field} string exceeds the safety limit.`);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${field} contains a non-finite number.`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100_000) throw new Error(`${field} array exceeds the safety limit.`);
    value.forEach((entry, index) => requireSafeJson(entry, `${field}[${index}]`, depth + 1));
    return;
  }
  if (!value || typeof value !== 'object') throw new Error(`${field} contains an unsupported value.`);
  for (const [key, entry] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new Error(`${field} contains a forbidden key.`);
    }
    requireSafeJson(entry, `${field}.${key}`, depth + 1);
  }
}

function validateSession(session: Session): Session {
  requireId(session.id, 'session.id');
  requireString(session.name, 'session.name');
  requirePrimitiveRecord(session.metadata, 'session.metadata');
  if (
    !session.processingRecipe ||
    typeof session.processingRecipe !== 'object' ||
    Array.isArray(session.processingRecipe)
  ) {
    throw new Error('session.processingRecipe must be an object.');
  }
  requireSafeJson(session.processingRecipe, 'session.processingRecipe');
  if (!Array.isArray(session.shots) || session.shots.length > 100_000) {
    throw new Error('session.shots is invalid or exceeds the safety limit.');
  }
  const ids = new Set<string>([session.id]);
  for (const shot of session.shots) {
    requireId(shot.id, 'shot.id');
    if (ids.has(shot.id)) throw new Error(`Duplicate object identifier: ${shot.id}`);
    ids.add(shot.id);
    requireString(shot.name, 'shot.name');
    requirePrimitiveRecord(shot.metadata, 'shot.metadata');
    if (!['unreviewed', 'in-progress', 'accepted', 'excluded'].includes(shot.reviewStatus)) {
      throw new Error(`Shot "${shot.name}" has an invalid review status.`);
    }
    if (typeof shot.notes !== 'string' || shot.notes.length > 1_000_000) {
      throw new Error(`Shot "${shot.name}" notes exceed the safety limit.`);
    }
    if (!Array.isArray(shot.sourceFiles) || !Array.isArray(shot.channels) || !Array.isArray(shot.annotations)) {
      throw new Error(`Shot "${shot.name}" collections are invalid.`);
    }
    shot.sourceFiles.forEach((sourceFile) => {
      requireId(sourceFile.id, 'sourceFile.id');
      if (ids.has(sourceFile.id)) throw new Error(`Duplicate object identifier: ${sourceFile.id}`);
      ids.add(sourceFile.id);
      requireString(sourceFile.name, 'sourceFile.name', 2000);
      requireString(sourceFile.adapterId, 'sourceFile.adapterId');
      requirePrimitiveRecord(sourceFile.metadata, 'sourceFile.metadata');
      requireStringArray(sourceFile.warnings, 'sourceFile.warnings');
      if (sourceFile.bytes !== undefined && !(sourceFile.bytes instanceof Uint8Array)) {
        throw new Error(`Source file "${sourceFile.name}" bytes are invalid.`);
      }
    });
    shot.channels.forEach((channel) => {
      requireId(channel.id, 'channel.id');
      if (ids.has(channel.id)) throw new Error(`Duplicate object identifier: ${channel.id}`);
      ids.add(channel.id);
      requireString(channel.name, 'channel.name');
      if (!(channel.time instanceof Float64Array) || !(channel.values instanceof Float64Array)) {
        throw new Error(`Channel "${channel.name}" numeric arrays are invalid.`);
      }
      if (
        !(channel.quality instanceof Uint16Array) ||
        channel.time.length !== channel.values.length ||
        channel.values.length !== channel.quality.length
      ) {
        throw new Error(`Channel "${channel.name}" arrays are not aligned.`);
      }
      if (
        (channel.originalTime && !(channel.originalTime instanceof Float64Array)) ||
        (channel.originalValues && !(channel.originalValues instanceof Float64Array)) ||
        (channel.originalQuality && !(channel.originalQuality instanceof Uint16Array))
      ) {
        throw new Error(`Channel "${channel.name}" original arrays are invalid.`);
      }
      const originalArrays = [channel.originalTime, channel.originalValues, channel.originalQuality];
      const originalArrayCount = originalArrays.filter(Boolean).length;
      if (
        (originalArrayCount !== 0 && originalArrayCount !== 3) ||
        originalArrays.some((array) => array && array.length !== channel.values.length)
      ) {
        throw new Error(`Channel "${channel.name}" original arrays are incomplete or unaligned.`);
      }
      requireTokenRecord(channel.originalValueTokens, `channel "${channel.name}" originalValueTokens`);
      requireTokenRecord(channel.originalTimeTokens, `channel "${channel.name}" originalTimeTokens`);
      if (channel.sourceUnit !== undefined) {
        requireString(channel.sourceUnit, `channel "${channel.name}" sourceUnit`, 100);
      }
      if (channel.sourceToSiScale !== undefined) {
        requireFinite(channel.sourceToSiScale, `channel "${channel.name}" sourceToSiScale`);
      }
      if (channel.sourceFormat !== undefined) {
        requireString(channel.sourceFormat, `channel "${channel.name}" sourceFormat`, 200);
      }
      requireFinite(channel.timingOffsetSeconds, `channel "${channel.name}" timingOffsetSeconds`);
      requireFinite(channel.calibration.scale, `channel "${channel.name}" calibration.scale`);
      requireFinite(channel.calibration.offset, `channel "${channel.name}" calibration.offset`);
    });
    shot.annotations.forEach((annotation) => {
      requireId(annotation.id, 'annotation.id');
      if (ids.has(annotation.id)) throw new Error(`Duplicate object identifier: ${annotation.id}`);
      ids.add(annotation.id);
      requireString(annotation.name, 'annotation.name');
      if (!['marker', 'region'].includes(annotation.kind) || !['manual', 'suggested'].includes(annotation.source)) {
        throw new Error(`Annotation "${annotation.name}" has an invalid kind or source.`);
      }
      if (
        annotation.suggestionState !== undefined &&
        !['pending', 'accepted', 'rejected'].includes(annotation.suggestionState)
      ) {
        throw new Error(`Annotation "${annotation.name}" has an invalid suggestion state.`);
      }
      requireFinite(annotation.startTime, `annotation "${annotation.name}" startTime`);
      if (annotation.endTime !== undefined)
        requireFinite(annotation.endTime, `annotation "${annotation.name}" endTime`);
    });
    if (!Array.isArray(shot.analysisResults) || !Array.isArray(shot.repairHistory)) {
      throw new Error(`Shot "${shot.name}" result or repair collections are invalid.`);
    }
    shot.analysisResults.forEach((result) => {
      requireId(result.id, 'analysisResult.id');
      if (ids.has(result.id)) throw new Error(`Duplicate object identifier: ${result.id}`);
      ids.add(result.id);
      requireString(result.type, 'analysisResult.type');
      requirePrimitiveRecord(result.values, 'analysisResult.values');
      if (!result.units || typeof result.units !== 'object') throw new Error('analysisResult.units is invalid.');
      requireStringArray(result.provenance.sourceChannelIds, 'analysisResult.provenance.sourceChannelIds');
      requireStringArray(result.provenance.annotationIds, 'analysisResult.provenance.annotationIds');
      requireStringArray(result.provenance.warnings, 'analysisResult.provenance.warnings');
    });
    const repairColumns = new Set(['Time', ...shot.channels.map((channel) => channel.name)]);
    const repairRowLimit = shot.channels[0]?.time.length || 0;
    shot.repairHistory.forEach((record, recordIndex) => {
      if (!record || typeof record !== 'object') {
        throw new Error(`Shot "${shot.name}" repairHistory[${recordIndex}] is invalid.`);
      }
      requireId(record.id, `repairHistory[${recordIndex}].id`);
      requireString(record.label, `repairHistory[${recordIndex}].label`, 1000);
      requireString(record.timestamp, `repairHistory[${recordIndex}].timestamp`, 100);
      if (!Array.isArray(record.changes) || record.changes.length > 10_000_000) {
        throw new Error(`repairHistory[${recordIndex}].changes is invalid.`);
      }
      record.changes.forEach((change, changeIndex) => {
        if (
          !change ||
          !Number.isInteger(change.rowIndex) ||
          change.rowIndex < 0 ||
          change.rowIndex >= repairRowLimit ||
          typeof change.columnId !== 'string' ||
          change.columnId.length === 0 ||
          !repairColumns.has(change.columnId) ||
          !Number.isInteger(change.qualityBefore) ||
          !Number.isInteger(change.qualityAfter) ||
          change.qualityBefore < 0 ||
          change.qualityAfter < 0 ||
          change.qualityBefore > 0xffff ||
          change.qualityAfter > 0xffff
        ) {
          throw new Error(`repairHistory[${recordIndex}].changes[${changeIndex}] is invalid.`);
        }
        for (const value of [change.before, change.after]) {
          if (value !== null && value !== undefined && !['string', 'number', 'boolean'].includes(typeof value)) {
            throw new Error(`repairHistory[${recordIndex}].changes[${changeIndex}] value is invalid.`);
          }
          if (typeof value === 'number' && !Number.isFinite(value)) {
            throw new Error(`repairHistory[${recordIndex}].changes[${changeIndex}] number is not finite.`);
          }
        }
      });
    });
    if (
      !Number.isInteger(shot.repairCursor) ||
      shot.repairCursor < 0 ||
      shot.repairCursor > shot.repairHistory.length
    ) {
      throw new Error(`Shot "${shot.name}" repair cursor is invalid.`);
    }
  }
  return session;
}

export function validateCurrentSession(session: Session): Session {
  if (session.schemaVersion !== CURRENT_SESSION_SCHEMA) {
    throw new Error(`Session schema ${session.schemaVersion} requires migration before current-schema validation.`);
  }
  return validateSession(session);
}

export function migrateSession(input: unknown): Session {
  if (!input || typeof input !== 'object') throw new Error('Session payload is not an object.');
  let migrated = structuredClone(input) as Record<string, unknown>;
  let version = Number(migrated.schemaVersion || 0);
  if (!Number.isInteger(version) || version < 0) throw new Error('Session schema version is invalid.');
  if (version > CURRENT_SESSION_SCHEMA) {
    throw new Error(`Session schema ${version} is newer than this application supports.`);
  }
  while (version < CURRENT_SESSION_SCHEMA) {
    if (version === 0) migrated = migrateVersionZero(migrated);
    version = Number(migrated.schemaVersion);
  }
  if (!migrated.id || !migrated.name || !Array.isArray(migrated.shots)) {
    throw new Error('Session payload is missing required fields.');
  }
  for (const shot of migrated.shots as Array<Record<string, unknown>>) {
    if (!Array.isArray(shot.repairHistory)) shot.repairHistory = [];
    if (!Number.isInteger(shot.repairCursor)) shot.repairCursor = (shot.repairHistory as unknown[]).length;
  }
  return validateSession(migrated as unknown as Session);
}
