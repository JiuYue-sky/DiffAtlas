import React, { useMemo, useState } from 'react';
import type { WorkspaceFileNode } from '../../core/git-workspace.js';
import type { ImpactTier } from '../../core/impact-analyzer.js';
import { isAnalyzableCodeLanguage } from '../../shared/languages.js';
import type { UiStrings } from '../i18n.js';

interface FileTreeViewProps {
  files: readonly WorkspaceFileNode[];
  impactTierMap: ReadonlyMap<string, ImpactTier>;
  canSelectForContext: boolean;
  selectedPaths: ReadonlySet<string>;
  strings: UiStrings;
  onToggleSelect: (relPath: string) => void;
  onOpenFileView: (file: WorkspaceFileNode) => void;
  onPreviewDiff: (file: WorkspaceFileNode) => void;
  onSimulateImpact: (relPath: string) => void;
}

interface FolderGroup {
  folder: string;
  files: WorkspaceFileNode[];
}

function gitStatusBadgeClass(st: WorkspaceFileNode['gitStatus']): string {
  if (st === 'modified' || st === 'renamed') return 'da-badge da-badge-warn';
  if (st === 'added' || st === 'untracked') return 'da-badge da-badge-ok';
  if (st === 'deleted') return 'da-badge da-badge-danger';
  return 'da-badge';
}

function impactTierBadge(tier: ImpactTier | undefined, strings: UiStrings): { label: string; cls: string } | null {
  if (tier === 'changed') return { label: strings.tierLabels.changed, cls: 'da-badge da-badge-danger' };
  if (tier === 'direct_impact') return { label: strings.tierLabels.direct_impact, cls: 'da-badge da-badge-warn' };
  if (tier === 'indirect_impact') return { label: strings.tierLabels.indirect_impact, cls: 'da-badge' };
  return null;
}

export function FileTreeView({
  files,
  impactTierMap,
  canSelectForContext,
  selectedPaths,
  strings,
  onToggleSelect,
  onOpenFileView,
  onPreviewDiff,
  onSimulateImpact,
}: FileTreeViewProps): React.ReactElement {
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());

  const groups = useMemo<FolderGroup[]>(() => {
    const map = new Map<string, WorkspaceFileNode[]>();
    for (const f of files) {
      const slash = f.relativePath.lastIndexOf('/');
      const folder = slash === -1 ? '(root)' : f.relativePath.slice(0, slash);
      const list = map.get(folder) ?? [];
      list.push(f);
      map.set(folder, list);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => (a === '(root)' ? -1 : b === '(root)' ? 1 : a.localeCompare(b)))
      .map(([folder, folderFiles]) => ({ folder, files: folderFiles }));
  }, [files]);

  const toggleDir = (dir: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
  };

  if (files.length === 0) {
    return (
      <div style={{ padding: 14, color: 'var(--da-text-tertiary)', textAlign: 'center' }}>
        {strings.treeNoMatch}
      </div>
    );
  }

  return (
    <div className="da-file-list">
      {groups.map((grp) => {
        const isCollapsed = collapsedDirs.has(grp.folder);
        const changedInDir = grp.files.filter((f) => f.gitStatus !== 'clean').length;
        const folderLabel = grp.folder === '(root)' ? strings.treeRootFolder : grp.folder;
        return (
          <div key={grp.folder} className="da-folder-block">
            <button
              type="button"
              className="da-folder-header"
              onClick={() => toggleDir(grp.folder)}
            >
              <span>{isCollapsed ? '▸' : '▾'}</span>
              <span className="da-mono" style={{ fontWeight: 600 }}>
                {folderLabel}
              </span>
              <span className="da-badge">{grp.files.length}</span>
              {changedInDir > 0 && <span className="da-badge da-badge-warn">{strings.treeChangedCount(changedInDir)}</span>}
            </button>

            {!isCollapsed &&
              grp.files.map((file) => {
                const fileName = file.relativePath.split('/').pop() ?? file.relativePath;
                const impBadge = impactTierBadge(impactTierMap.get(file.relativePath), strings);
                const canAnalyze = isAnalyzableCodeLanguage(file.language);

                return (
                  <div key={file.relativePath} className="da-file-row">
                    <div className="da-file-left">
                      {canSelectForContext && (
                        <input
                          type="checkbox"
                          checked={selectedPaths.has(file.relativePath)}
                          onChange={() => onToggleSelect(file.relativePath)}
                          aria-label={`Select ${file.relativePath}`}
                        />
                      )}
                      {file.gitStatus !== 'clean' && (
                        <span className={gitStatusBadgeClass(file.gitStatus)}>
                          {strings.gitStatusLabels[file.gitStatus] ?? file.gitStatus}
                        </span>
                      )}
                      {impBadge && <span className={impBadge.cls}>{impBadge.label}</span>}
                      <span className="da-mono" title={file.relativePath}>
                        {fileName}
                      </span>
                      {file.isTestFile && <span className="da-badge">{strings.treeTestBadge}</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                      {canAnalyze && (
                        <button
                          type="button"
                          className="da-btn"
                          title={strings.treeSimulateTooltip}
                          onClick={() => onSimulateImpact(file.relativePath)}
                        >
                          {strings.simulateImpactBtn}
                        </button>
                      )}
                      <button type="button" className="da-btn" onClick={() => onPreviewDiff(file)}>
                        {strings.diffBtn}
                      </button>
                      <button
                        type="button"
                        className="da-btn da-btn-primary"
                        onClick={() => onOpenFileView(file)}
                      >
                        {strings.fileViewShortBtn}
                      </button>
                    </div>
                  </div>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}
