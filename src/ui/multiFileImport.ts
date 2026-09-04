import { createShot } from '../domain/session';
import {
  compileFilenameProfile,
  matchFilename,
  type CompiledFilenameProfile,
  type FilenameMatch
} from '../io/filenameProfile';
import { ImportAdapterRegistry } from '../io/adapters/registry';
import type { ImportSource } from '../io/adapters/types';
import { attachAdapterRecord, firstMetadataConflict } from '../io/adapters/sessionBridge';
import { groupScopeSources } from '../io/scope/groupFiles';
import { estimateNativeSessionPeakBytes } from '../io/scope/bridge';
import { ScopeImportLimits } from '../io/scope/limits';
import { SessionWorkspace } from '../session/workspace';
import { sessionRepository } from '../persistence/sessionRepository';
import { renderColumnTabs } from '../app/tabs';
import { runPipelineAndRender } from '../app/dataPipeline';
import { closeModal, createModal, escapeHtml } from './uiHelpers';
import { ui } from './classes';

interface PreviewFile {
  file: File;
  source: ImportSource;
  companions: ImportSource[];
  consumedNames: string[];
  match: FilenameMatch;
  corrections: Record<string, string>;
}

const DEFAULT_FILENAME_PROFILE =
  'shot {shot:int} - {charge_voltage:quantity[V]} - {length:quantity[mm]} - {channel:text}.csv';

function filenameExample(profile: string): string {
  return profile.replace(/\{([A-Za-z_][A-Za-z0-9_]*):([^}]+)\}/g, (_token, name: string, specification: string) => {
    if (name === 'shot') return '7';
    if (name === 'charge_voltage') return '25kV';
    if (name === 'length') return '200mm';
    if (name === 'channel') return 'Voltage';
    if (specification === 'int') return '7';
    if (specification === 'number') return '42';
    if (specification === 'text') return 'example';
    const unit = specification.match(/^quantity\[([^\]]+)\]$/i)?.[1];
    return unit ? `25${unit}` : 'value';
  });
}

export const MultiFileImport = {
  content: null as HTMLElement | null,
  profile: null as CompiledFilenameProfile | null,
  previews: [] as PreviewFile[],
  previewController: null as AbortController | null,
  importController: null as AbortController | null,

  show(): void {
    this.previews = [];
    this.content = createModal(
      `
      <h2 class="${ui.modalTitle}">Multi-file Shot Import</h2>
      <label class="mb-2 inline-flex items-center gap-2 text-sm">
        <input id="multi-use-profile" type="checkbox" class="h-4 w-4 accent-accent" checked>
        Extract shot metadata from a filename convention
      </label>
      <label class="sf-label" for="multi-profile">Filename convention profile</label>
      <input id="multi-profile" class="sf-field mb-2"
        value="${escapeHtml(DEFAULT_FILENAME_PROFILE)}">
      <p id="multi-profile-example" class="sf-hint mb-1">
        Example filename: <code>${escapeHtml(filenameExample(DEFAULT_FILENAME_PROFILE))}</code>
      </p>
      <p id="multi-profile-mode-hint" class="sf-hint mb-3">
        Matching files are grouped by shot metadata. Turn this off to accept any supported filename and create one shot per file.
      </p>
      <div class="mb-3 flex flex-wrap gap-2">
        <input id="multi-files" type="file" multiple
          accept=".csv,.tsv,.txt,.wfm,.isf,.trc,.000,.bin,.h5,.hdf5,.psdata"
          class="sf-field max-w-lg">
        <button id="multi-preview" class="sf-btn" type="button">Preview extraction</button>
      </div>
      <p id="multi-error" class="mb-2 hidden text-sm text-red-500"></p>
      <div id="multi-preview-table" class="max-h-96 overflow-auto"></div>
      <div class="mt-3 flex items-center justify-between gap-2">
        <span class="sf-hint">Native support is content-detected and evidence-labelled; provisional variants are rejected.</span>
        <button id="multi-import" class="sf-btn" type="button" disabled>Import matched files</button>
      </div>
    `,
      {
        onClose: () => {
          this.previewController?.abort();
          this.previewController = null;
          this.importController?.abort();
          this.importController = null;
          this.content = null;
          this.previews = [];
          this.profile = null;
        }
      }
    );
    this.content.className = `${ui.modal} max-w-7xl`;
    this.bind();
  },

  bind(): void {
    this.content?.querySelector('#multi-preview')?.addEventListener('click', () => void this.preview());
    this.content?.querySelector('#multi-import')?.addEventListener('click', () => void this.importMatched());
    const useProfile = this.content?.querySelector<HTMLInputElement>('#multi-use-profile');
    const profile = this.content?.querySelector<HTMLInputElement>('#multi-profile');
    const example = this.content?.querySelector<HTMLElement>('#multi-profile-example');
    const hint = this.content?.querySelector<HTMLElement>('#multi-profile-mode-hint');
    const fileInput = this.content?.querySelector<HTMLInputElement>('#multi-files');
    const importButton = this.content?.querySelector<HTMLButtonElement>('#multi-import');
    const invalidatePreview = () => {
      this.previewController?.abort();
      this.previewController = null;
      this.previews = [];
      this.profile = null;
      if (importButton) importButton.disabled = true;
    };
    const refreshProfileMode = () => {
      const enabled = useProfile?.checked !== false;
      if (profile) profile.disabled = !enabled;
      if (example) {
        example.innerHTML = enabled
          ? `Example filename: <code>${escapeHtml(filenameExample(profile?.value || DEFAULT_FILENAME_PROFILE))}</code>`
          : 'No filename convention: any supported filename is accepted and each file becomes its own shot.';
      }
      if (hint) {
        hint.textContent = enabled
          ? 'Matching files are grouped by shot metadata. Turn this off to accept any supported filename and create one shot per file.'
          : 'File contents still need a supported importer; only filename matching and metadata extraction are bypassed.';
      }
    };
    useProfile?.addEventListener('change', () => {
      invalidatePreview();
      refreshProfileMode();
    });
    profile?.addEventListener('input', () => {
      invalidatePreview();
      refreshProfileMode();
    });
    fileInput?.addEventListener('change', invalidatePreview);
    refreshProfileMode();
  },

  async preview(): Promise<void> {
    const profileInput = this.content?.querySelector<HTMLInputElement>('#multi-profile');
    const useProfileInput = this.content?.querySelector<HTMLInputElement>('#multi-use-profile');
    const fileInput = this.content?.querySelector<HTMLInputElement>('#multi-files');
    const error = this.content?.querySelector<HTMLElement>('#multi-error');
    const table = this.content?.querySelector<HTMLElement>('#multi-preview-table');
    const importButton = this.content?.querySelector<HTMLButtonElement>('#multi-import');
    if (!profileInput || !fileInput || !error || !table || !importButton) return;
    this.previewController?.abort();
    const controller = new AbortController();
    this.previewController = controller;
    try {
      const useProfile = useProfileInput?.checked !== false;
      this.profile = useProfile ? compileFilenameProfile(profileInput.value.trim()) : null;
      const files = Array.from(fileInput.files || []);
      if (files.length > 10_000) throw new Error('Select no more than 10,000 files per import.');
      const oversized = files.find((file) => file.size > ScopeImportLimits.maxFileBytes);
      if (oversized) {
        throw new Error(
          `${oversized.name} exceeds the ${ScopeImportLimits.maxFileBytes}-byte native file safety limit.`
        );
      }
      const totalBytes = files.reduce((total, file) => total + file.size, 0);
      if (totalBytes > 64 * 1024 * 1024) {
        throw new Error('Selected files exceed the 64 MB aggregate preview safety limit.');
      }
      const loaded: Array<{ file: File; source: ImportSource }> = [];
      for (const file of files) {
        if (controller.signal.aborted) return;
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (controller.signal.aborted) return;
        loaded.push({
          file,
          source: { name: file.name, bytes, size: file.size, lastModified: file.lastModified || null }
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      const groups = groupScopeSources(loaded.map(({ source }) => source));
      if (controller.signal.aborted || !this.content) return;
      this.previews = groups.map((group) => {
        const loadedPrimary = loaded.find(({ source }) => source === group.primary);
        if (!loadedPrimary) throw new Error(`Internal import grouping failed for ${group.primary.name}.`);
        return {
          file: loadedPrimary.file,
          source: group.primary,
          companions: group.companions,
          consumedNames: group.consumedNames,
          match: this.profile
            ? matchFilename(this.profile as CompiledFilenameProfile, group.primary.name)
            : { filename: group.primary.name, matched: true, fields: {}, warnings: [] },
          corrections: {}
        };
      });
      if (this.previews.length === 0) throw new Error('Select one or more waveform files.');
      error.classList.add('hidden');
      table.innerHTML = `
        <table class="w-full border-collapse text-sm">
          <thead><tr>
            <th class="border border-line p-2 text-left">File</th>
            ${(this.profile?.fields || []).map((field) => `<th class="border border-line p-2 text-left">${escapeHtml(field.name)}</th>`).join('')}
            <th class="border border-line p-2 text-left">Adapter / warnings</th>
          </tr></thead>
          <tbody>
            ${this.previews
              .map((preview, index) => {
                const candidates = ImportAdapterRegistry.identify(preview.source);
                const adapter = candidates[0];
                const warnings = [
                  ...preview.match.warnings,
                  ...(adapter ? [] : ['No importer identified.']),
                  ...(adapter?.adapter.id === 'native-oscilloscope' ? [adapter.identification.reason] : []),
                  ...(adapter?.adapter.status === 'fixture-required' ? [adapter.identification.reason] : [])
                ];
                return `<tr class="${preview.match.matched ? '' : 'bg-red-500/10'}">
                  <td class="border border-line p-2">${escapeHtml(preview.consumedNames.join(' + '))}</td>
                  ${this.profile?.fields
                    .map((field) => {
                      const extracted = preview.match.fields[field.name];
                      return `<td class="border border-line p-1">
                        <input class="sf-field" data-preview="${index}" data-field="${escapeHtml(field.name)}"
                          value="${escapeHtml(extracted?.raw || '')}" aria-label="${escapeHtml(field.name)} for ${escapeHtml(preview.file.name)}">
                        ${
                          extracted?.valueSi === null || extracted?.valueSi === undefined
                            ? ''
                            : `<small class="block text-muted">SI: ${escapeHtml(extracted.valueSi)}</small>`
                        }
                      </td>`;
                    })
                    .join('')}
                  <td class="border border-line p-2">${escapeHtml(
                    `${adapter?.identification.format || adapter?.adapter.name || 'Unknown'}${
                      adapter?.identification.manufacturer ? ` · ${adapter.identification.manufacturer}` : ''
                    }${warnings.length ? ` — ${warnings.join(' ')}` : ''}`
                  )}</td>
                </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      `;
      table.querySelectorAll<HTMLInputElement>('[data-preview][data-field]').forEach((input) => {
        input.addEventListener('input', () => {
          const preview = this.previews[Number(input.dataset.preview)];
          if (preview && input.dataset.field) preview.corrections[input.dataset.field] = input.value;
        });
      });
      importButton.disabled = false;
      if (this.previewController === controller) this.previewController = null;
    } catch (caught) {
      if (controller.signal.aborted) return;
      this.previews = [];
      error.textContent = caught instanceof Error ? caught.message : String(caught);
      error.classList.remove('hidden');
      table.innerHTML = '';
      importButton.disabled = true;
      if (this.previewController === controller) this.previewController = null;
    }
  },

  async importMatched(): Promise<void> {
    if (this.previews.length === 0) return;
    const importButton = this.content?.querySelector<HTMLButtonElement>('#multi-import');
    if (importButton?.disabled) return;
    if (importButton) importButton.disabled = true;
    if (!SessionWorkspace.activeSession) SessionWorkspace.create('Imported session');
    const activeSession = SessionWorkspace.activeSession;
    if (!activeSession) return;
    this.importController?.abort();
    const controller = new AbortController();
    this.importController = controller;
    const session = { ...activeSession, shots: [...activeSession.shots] };
    const shots = new Map<string, ReturnType<typeof createShot>>();
    const warnings: string[] = [];
    let retainedPreviewBytes = this.previews.reduce(
      (total, preview) =>
        total +
        preview.source.bytes.byteLength +
        preview.companions.reduce((companionTotal, source) => companionTotal + source.bytes.byteLength, 0),
      0
    );
    let cumulativeSourceBytes = activeSession.shots.reduce(
      (total, existingShot) =>
        total +
        existingShot.sourceFiles.reduce(
          (sourceTotal, sourceFile) => sourceTotal + (sourceFile.bytes?.byteLength || 0),
          0
        ),
      0
    );
    let cumulativeChannelSamples = activeSession.shots.reduce(
      (total, existingShot) =>
        total + existingShot.channels.reduce((channelTotal, channel) => channelTotal + channel.values.length, 0),
      0
    );
    const releasePreview = (preview: PreviewFile) => {
      const released =
        preview.source.bytes.byteLength +
        preview.companions.reduce((total, source) => total + source.bytes.byteLength, 0);
      preview.source.bytes = new Uint8Array(0);
      preview.companions.forEach((source) => {
        source.bytes = new Uint8Array(0);
      });
      retainedPreviewBytes -= released;
    };

    for (const [previewIndex, preview] of this.previews.entries()) {
      if (controller.signal.aborted) return;
      const adapter = ImportAdapterRegistry.supportedFor(preview.source);
      if (!adapter) {
        warnings.push(`${preview.file.name}: no fixture-validated adapter is available.`);
        releasePreview(preview);
        continue;
      }
      const usesProfile = this.profile !== null;
      const shotValue = usesProfile
        ? preview.corrections.shot ||
          String(preview.match.fields.shot?.value ?? preview.match.fields.shot?.raw ?? preview.file.name)
        : preview.file.name.replace(/\.[^.]+$/, '') || `File ${previewIndex + 1}`;
      const shotKey = usesProfile ? shotValue : `file:${previewIndex}`;
      let shot = shots.get(shotKey);
      if (!shot) {
        const sequence = Number(shotValue);
        shot = createShot(
          usesProfile ? `Shot ${shotValue}` : shotValue,
          usesProfile && Number.isInteger(sequence) ? sequence : null
        );
      }
      const metadataEntries: Array<[string, string | number | boolean]> = [];
      for (const field of this.profile?.fields || []) {
        if (field.name === 'channel') continue;
        const corrected = preview.corrections[field.name];
        const extracted = preview.match.fields[field.name];
        const value =
          corrected !== undefined && corrected !== '' ? corrected : (extracted?.valueSi ?? extracted?.value);
        if (value !== undefined) {
          metadataEntries.push([field.name, value]);
          if (corrected !== undefined && corrected !== '') {
            metadataEntries.push([`${field.name}_manually_corrected`, true]);
          }
        }
      }
      const conflict = firstMetadataConflict(shot.metadata, metadataEntries);
      if (conflict) {
        warnings.push(
          `${preview.file.name}: ${conflict[0]} conflicts with another file in Shot ${shotValue}; file was not merged.`
        );
        releasePreview(preview);
        continue;
      }
      try {
        const imported = await adapter.import(preview.source, {
          companions: preview.companions,
          signal: controller.signal,
          onProgress: (progress, stage) => {
            if (importButton) {
              importButton.textContent = `${stage} · ${Math.round(progress * 100)}%`;
            }
          }
        });
        if (controller.signal.aborted) return;
        const records = imported.records || [
          {
            channels: imported.channels,
            metadata: imported.metadata,
            warnings: imported.warnings,
            frameIndex: 0
          }
        ];
        const importedSourceBytes =
          preview.source.bytes.byteLength +
          preview.companions.reduce((total, source) => total + source.bytes.byteLength, 0);
        const importedChannelSamples = records.reduce(
          (total, record) =>
            total + record.channels.reduce((channelTotal, channel) => channelTotal + channel.values.length, 0),
          0
        );
        const predictedPeakBytes = estimateNativeSessionPeakBytes(
          cumulativeSourceBytes + importedSourceBytes,
          cumulativeChannelSamples + importedChannelSamples,
          retainedPreviewBytes
        );
        if (!Number.isSafeInteger(predictedPeakBytes) || predictedPeakBytes > ScopeImportLimits.maxDecodedBytes) {
          warnings.push(
            `${preview.file.name}: cumulative import would require approximately ${predictedPeakBytes} bytes and exceed the ${ScopeImportLimits.maxDecodedBytes}-byte session budget.`
          );
          releasePreview(preview);
          continue;
        }
        for (const [recordIndex, record] of records.entries()) {
          const recordKey = records.length > 1 ? `${shotKey}:frame:${record.frameIndex}` : shotKey;
          let recordShot = records.length > 1 ? shots.get(recordKey) : shot;
          if (!recordShot) {
            recordShot = createShot(
              records.length > 1
                ? `${usesProfile ? `Shot ${shotValue}` : shotValue} · Frame ${record.frameIndex + 1}`
                : usesProfile
                  ? `Shot ${shotValue}`
                  : shotValue,
              usesProfile && Number.isInteger(Number(shotValue)) ? Number(shotValue) : null
            );
          }
          const recordConflict = firstMetadataConflict(recordShot.metadata, metadataEntries);
          if (recordConflict) {
            warnings.push(
              `${preview.file.name}: ${recordConflict[0]} conflicts in frame ${record.frameIndex + 1}; record was not merged.`
            );
            continue;
          }
          metadataEntries.forEach(([field, value]) => {
            recordShot.metadata[field] = value;
          });
          recordShot.metadata.source_format = String(
            record.metadata.sourceFormat || imported.metadata.sourceFormat || ''
          );
          recordShot.metadata.support_level = String(
            record.metadata.supportLevel || imported.supportLevel || 'verified'
          );
          if (records.length > 1) {
            recordShot.metadata.frame_index = record.frameIndex;
            recordShot.metadata.frame_count = records.length;
          }
          const attached = attachAdapterRecord(imported, record, recordIndex === 0);
          recordShot.sourceFiles.push(...attached.sources);
          for (const channel of attached.channels) {
            const requestedName =
              preview.corrections.channel || String(preview.match.fields.channel?.value || channel.name);
            const channelConflict = recordShot.channels.some((existing) => existing.name === requestedName);
            channel.name = channelConflict ? `${requestedName} (${preview.file.name})` : requestedName;
            recordShot.channels.push(channel);
          }
          shots.set(recordKey, recordShot);
        }
        cumulativeSourceBytes += importedSourceBytes;
        cumulativeChannelSamples += importedChannelSamples;
        releasePreview(preview);
        warnings.push(...imported.warnings.map((warning) => `${preview.file.name}: ${warning}`));
      } catch (error) {
        releasePreview(preview);
        warnings.push(`${preview.file.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (importButton) importButton.textContent = 'Import matched files';

    if (shots.size === 0) {
      alert(`No files were imported.${warnings.length ? `\n\n${warnings.join('\n')}` : ''}`);
      this.importController = null;
      if (importButton) importButton.disabled = false;
      return;
    }
    for (const shot of shots.values()) session.shots.push(shot);
    session.updatedAt = new Date().toISOString();
    if (controller.signal.aborted) return;
    let saved;
    try {
      saved = await sessionRepository.save(session);
    } catch (error) {
      alert(`Session save failed: ${error instanceof Error ? error.message : String(error)}`);
      this.importController = null;
      if (importButton) importButton.disabled = false;
      return;
    }
    if (controller.signal.aborted) {
      await sessionRepository.save(activeSession);
      return;
    }
    this.importController = null;
    SessionWorkspace.setActive(saved, saved.shots.at(-1)?.id || null);
    renderColumnTabs();
    runPipelineAndRender();
    alert(`Imported ${shots.size} shot(s).${warnings.length ? `\n\n${warnings.join('\n')}` : ''}`);
    closeModal(this.content);
  }
};
