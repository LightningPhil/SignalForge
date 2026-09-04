import { createSession, createShot } from '../domain/session';
import { ImportAdapterRegistry } from '../io/adapters/registry';
import { attachAdapterRecord } from '../io/adapters/sessionBridge';
import type { AdapterWaveformRecord, ImportSource } from '../io/adapters/types';
import { CsvParser } from '../io/csvParser';
import { ScopeImportLimits } from '../io/scope/limits';
import { sessionRepository } from '../persistence/sessionRepository';
import { State } from '../state';
import { SessionWorkspace } from '../session/workspace';
import { renderComposerPanel } from './composerUi';
import { runPipelineAndRender } from './dataPipeline';
import { renderColumnTabs } from './tabs';

let activeImportController: AbortController | null = null;
let importGeneration = 0;

export function handleFileSelection(file: File | undefined, onStatusChange?: (status: string) => void): void {
  if (!file) return;
  activeImportController?.abort();
  const controller = new AbortController();
  activeImportController = controller;
  const generation = ++importGeneration;
  onStatusChange?.('Loading...');

  void (async () => {
    const textExtension = /\.(?:csv|tsv|txt)$/i.test(file.name);
    if (textExtension) {
      const probeBytes = new Uint8Array(await file.slice(0, Math.min(file.size, 8192)).arrayBuffer());
      const probeSource: ImportSource = {
        name: file.name,
        bytes: probeBytes,
        size: file.size,
        lastModified: file.lastModified || null
      };
      const nativeText = ImportAdapterRegistry.identify(probeSource).some(
        ({ adapter, identification }) => adapter.id === 'native-oscilloscope' && identification.confidence > 0
      );
      if (!nativeText) {
        CsvParser.processFile(file, (results, source) => {
          if (controller.signal.aborted || generation !== importGeneration) return;
          State.setData(results.data, results.meta.fields || [], source);
          State.syncComposerForView(null, State.getActiveComposerColumns());
          renderColumnTabs();
          renderComposerPanel();
          runPipelineAndRender();
          onStatusChange?.('Ready');
          if (activeImportController === controller) activeImportController = null;
        });
        return;
      }
    }
    if (file.size > ScopeImportLimits.maxFileBytes) {
      throw new Error(`Native waveform exceeds the ${ScopeImportLimits.maxFileBytes}-byte file limit.`);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const source: ImportSource = {
      name: file.name,
      bytes,
      size: file.size,
      lastModified: file.lastModified || null
    };
    const identified = ImportAdapterRegistry.identify(source);
    const adapter = ImportAdapterRegistry.supportedFor(source);
    if (!adapter) {
      throw new Error(identified[0]?.identification.reason || `No importer recognizes ${file.name}.`);
    }
    const imported = await adapter.import(source, {
      signal: controller.signal,
      onProgress: (progress, stage) => onStatusChange?.(`${stage} · ${Math.round(progress * 100)}%`)
    });
    if (controller.signal.aborted || generation !== importGeneration) return;
    const records: AdapterWaveformRecord[] = imported.records || [
      {
        channels: imported.channels,
        metadata: imported.metadata,
        warnings: imported.warnings,
        frameIndex: 0
      }
    ];
    const session = createSession(file.name.replace(/\.[^.]+$/, '') || 'Imported waveform');
    for (const [recordIndex, record] of records.entries()) {
      const shot = createShot(
        records.length > 1 ? `${session.name} · Frame ${record.frameIndex + 1}` : session.name,
        records.length > 1 ? record.frameIndex + 1 : null
      );
      shot.metadata = {
        ...record.metadata,
        source_format: String(record.metadata.sourceFormat || imported.metadata.sourceFormat || ''),
        support_level: String(record.metadata.supportLevel || imported.supportLevel || 'verified'),
        ...(records.length > 1 ? { frame_index: record.frameIndex, frame_count: records.length } : {})
      };
      const attached = attachAdapterRecord(imported, record, recordIndex === 0);
      shot.sourceFiles.push(...attached.sources);
      shot.channels.push(...attached.channels);
      session.shots.push(shot);
    }
    const saved = await sessionRepository.save(session);
    if (controller.signal.aborted || generation !== importGeneration) {
      await sessionRepository.delete(saved.id);
      return;
    }
    SessionWorkspace.setActive(saved, saved.shots[0]?.id || null);
    State.syncComposerForView(null, State.getActiveComposerColumns());
    renderColumnTabs();
    renderComposerPanel();
    runPipelineAndRender();
    onStatusChange?.('Ready');
    if (activeImportController === controller) activeImportController = null;
    if (imported.warnings.length > 0) alert(`Import warnings:\n${imported.warnings.join('\n')}`);
  })().catch((error: unknown) => {
    if (controller.signal.aborted || generation !== importGeneration) return;
    const message = error instanceof Error ? error.message : String(error);
    if (activeImportController === controller) activeImportController = null;
    onStatusChange?.(`Import failed: ${message}`);
    alert(`Import failed: ${message}`);
  });
}
