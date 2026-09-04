export const cx = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(' ');

export const ui = {
  pipelineStep:
    'flex cursor-pointer items-center border-b border-line px-2 py-2 text-sm hover:bg-list-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent',
  pipelineStepSelected: 'border-l-[3px] border-l-accent bg-selected',
  pipelineStepDisabled: 'opacity-55',
  stepNum:
    'mr-2 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-pill text-xs font-semibold text-main',
  stepDesc: 'min-w-0 truncate',
  tab: 'flex h-[35px] min-w-20 max-w-56 flex-1 items-center gap-1.5 overflow-hidden border-r border-line bg-transparent px-3.5 text-left text-sm text-muted select-none hover:bg-btn-hover hover:text-main focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent',
  tabActive: 'border-b-2 border-accent bg-tab-active font-semibold text-main',
  tabVirtualActive: 'border-b-2 border-math text-math',
  tabAction:
    'inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border border-line bg-panel text-xs text-muted hover:border-accent hover:bg-btn-hover hover:text-main focus-visible:outline-2 focus-visible:outline-accent',
  tabSep: 'mx-1 h-5 w-px shrink-0 border-l border-line',
  tabPlaceholder: 'flex h-[35px] items-center px-3.5 text-sm text-muted',
  composerRow: 'rounded-md border border-line bg-surface p-2.5',
  modalOverlay: 'fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-[2px]',
  modal:
    'js-modal-enter max-h-[90vh] w-full min-w-0 max-w-3xl overflow-auto rounded-lg border border-line bg-panel p-6 text-main shadow-2xl',
  modalTitle: 'mb-3 border-b border-line pb-2 text-lg font-semibold',
  modalPanel: 'mb-4 rounded-md border border-line bg-surface p-4',
  modalActions: 'mt-4 flex flex-wrap justify-end gap-2',
  addOpt:
    'mb-1.5 w-full rounded-md border border-btn-border bg-btn px-3 py-2.5 text-left text-sm text-btn-text hover:border-accent hover:bg-btn-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
  toggleLabel: 'inline-flex items-center gap-2 text-sm text-main',
  treeHeader:
    'flex w-full cursor-pointer items-center gap-2 rounded-md bg-linear-to-b from-toolbar to-surface px-3 py-2.5 text-left font-semibold text-main select-none focus-visible:outline-2 focus-visible:outline-accent',
  treeItem:
    'w-full cursor-pointer rounded-md px-2.5 py-2 text-left text-sm text-muted transition hover:bg-btn-hover hover:text-main focus-visible:outline-2 focus-visible:outline-accent',
  treeItemActive: 'bg-accent font-semibold text-white hover:bg-accent hover:text-white',
  sidebarTab:
    'flex-1 rounded-md px-2 py-1.5 text-xs font-semibold text-muted hover:bg-btn-hover hover:text-main focus-visible:outline-2 focus-visible:outline-accent',
  sidebarTabActive: 'bg-surface text-main shadow-sm',
  analysisTable: 'w-full border-collapse text-left text-xs',
  analysisTableCell: 'border-b border-line px-1.5 py-1',
  eventRow: 'cursor-pointer rounded-md border border-transparent px-2 py-1.5 text-xs hover:bg-btn-hover',
  eventRowActive: 'border-accent bg-selected'
};
