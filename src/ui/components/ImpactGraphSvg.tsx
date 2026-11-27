import React, { useEffect, useMemo, useRef } from 'react';
import type { ImpactGraphEdge, ImpactGraphNode, ImpactTier } from '../../core/impact-analyzer.js';
import type { UiStrings } from '../i18n.js';

interface ImpactGraphSvgProps {
  nodes: readonly ImpactGraphNode[];
  edges: readonly ImpactGraphEdge[];
  selectedNodeId: string | null;
  strings: UiStrings;
  onSelectNode: (node: ImpactGraphNode) => void;
}

interface PositionedNode {
  node: ImpactGraphNode;
  x: number;
  y: number;
  w: number;
  h: number;
}

const COLUMN_ORDER: readonly ImpactTier[] = [
  'upstream_dependency',
  'changed',
  'direct_impact',
  'indirect_impact',
];

const COLUMN_TITLES: Record<ImpactTier, string> = {
  upstream_dependency: 'Upstream Deps',
  changed: 'Changed (Hop 0)',
  direct_impact: 'Direct Impact (1-hop)',
  indirect_impact: 'Indirect (2-hop)',
};

const TIER_STROKE: Record<ImpactTier, string> = {
  upstream_dependency: 'var(--da-border)',
  changed: 'var(--da-danger)',
  direct_impact: 'var(--da-warning)',
  indirect_impact: 'var(--da-accent)',
};

const TIER_FILL: Record<ImpactTier, string> = {
  upstream_dependency: 'var(--da-bg-primary)',
  changed: 'rgba(225, 29, 72, 0.14)',
  direct_impact: 'rgba(217, 119, 6, 0.14)',
  indirect_impact: 'rgba(2, 132, 199, 0.14)',
};

function shortNodeLabel(relPath: string): string {
  const parts = relPath.split('/');
  if (parts.length <= 2) return relPath;
  return `…/${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

/**
 * Pure React + inline SVG layered dependency impact graph.
 * Strictly zero external scripts/CDN (100% CSP `default-src 'none'` safe) and strict text-node rendering only.
 */
export function ImpactGraphSvg({
  nodes,
  edges,
  selectedNodeId,
  strings,
  onSelectNode,
}: ImpactGraphSvgProps): React.ReactElement {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  // Reset scroll back to top-left whenever the graph target/tier set changes so `Changed (Hop 0)` is always visible first!
  const graphSignature = useMemo(() => nodes.slice(0, 6).map((n) => `${n.tier}:${n.id}`).join('|'), [nodes]);
  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
      scrollContainerRef.current.scrollLeft = 0;
    }
  }, [graphSignature]);

  const layout = useMemo(() => {
    const activeColumns = COLUMN_ORDER.filter((tier) => nodes.some((n) => n.tier === tier));
    const colWidth = 196;
    const nodeW = 166;
    const nodeH = 34;
    const rowGap = 12;
    const padX = 16;
    const padTop = 12;

    const positioned = new Map<string, PositionedNode>();
    const overflowByTier = new Map<ImpactTier, number>();
    let maxRows = 1;
    const maxPerCol = 14;

    activeColumns.forEach((tier, colIdx) => {
      const allInTier = nodes.filter((n) => n.tier === tier);
      if (allInTier.length > maxPerCol) {
        overflowByTier.set(tier, allInTier.length - maxPerCol);
      }
      const colNodes = allInTier.slice(0, maxPerCol);
      maxRows = Math.max(maxRows, colNodes.length);
      colNodes.forEach((node, rowIdx) => {
        positioned.set(node.id, {
          node,
          x: padX + colIdx * colWidth,
          y: padTop + rowIdx * (nodeH + rowGap),
          w: nodeW,
          h: nodeH,
        });
      });
    });

    const hasOverflow = overflowByTier.size > 0;
    const width = Math.max(420, padX * 2 + activeColumns.length * colWidth - (colWidth - nodeW) + 28);
    const height = Math.max(130, padTop + maxRows * (nodeH + rowGap) + (hasOverflow ? 28 : 14));

    return { activeColumns, colWidth, padX, padTop, nodeH, rowGap, width, height, positioned, overflowByTier };
  }, [nodes]);

  const visibleEdges = useMemo(() => {
    return edges.filter((e) => layout.positioned.has(e.from) && layout.positioned.has(e.to)).slice(0, 120);
  }, [edges, layout.positioned]);

  if (nodes.length === 0) {
    return (
      <div className="da-empty-graph">
        {strings.graphEmptyState}
      </div>
    );
  }

  return (
    <div ref={scrollContainerRef} className="da-graph-scroll">
      {/* Sticky Column Header Strip so tier titles stay visible while scrolling tall 1-hop lists */}
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 2,
          display: 'flex',
          minWidth: layout.width,
          paddingLeft: layout.padX,
          paddingTop: 6,
          paddingBottom: 5,
          background: 'var(--da-bg-primary)',
          borderBottom: '1px solid var(--da-border)',
        }}
      >
        {layout.activeColumns.map((tier) => (
          <div
            key={tier}
            style={{
              width: layout.colWidth,
              flexShrink: 0,
              fontSize: 11,
              fontWeight: 700,
              color: 'var(--da-text-secondary)',
              paddingLeft: 4,
            }}
          >
            {strings.columnTitles[tier] ?? COLUMN_TITLES[tier]}
          </div>
        ))}
      </div>

      <svg
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label="DiffAtlas Dependency Impact Graph"
        style={{ display: 'block' }}
      >
        <defs>
          <marker
            id="da-arrow-high"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="var(--da-accent)" />
          </marker>
          <marker
            id="da-arrow-low"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="var(--da-text-tertiary)" />
          </marker>
        </defs>

        {/* Edges (drawn from dependency target -> impacted importer so flow reads left-to-right!) */}
        {visibleEdges.map((edge, idx) => {
          const importer = layout.positioned.get(edge.from);
          const imported = layout.positioned.get(edge.to);
          if (!importer || !imported) return null;

          const sameColumn = Math.abs(imported.x - importer.x) < 4;
          const leftToRight = imported.x < importer.x;
          const x1 = sameColumn || leftToRight ? imported.x + imported.w : imported.x;
          const y1 = imported.y + imported.h / 2;
          const x2 = sameColumn ? importer.x + importer.w : leftToRight ? importer.x : importer.x + importer.w;
          const y2 = importer.y + importer.h / 2;
          const dx = Math.max(24, Math.abs(x2 - x1) * 0.45);
          const c1x = leftToRight ? x1 + dx : x1 - dx;
          const c2x = leftToRight ? x2 - dx : x2 + dx;
          const pathD = sameColumn
            ? `M ${x1} ${y1} C ${x1 + 26} ${y1}, ${x2 + 26} ${y2}, ${x2} ${y2}`
            : `M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`;

          const isHighlighted =
            selectedNodeId !== null && (edge.from === selectedNodeId || edge.to === selectedNodeId);
          const dimmed = selectedNodeId !== null && !isHighlighted;
          const isLow = edge.confidence === 'low';

          return (
            <path
              key={`${edge.from}->${edge.to}:${edge.line}:${idx}`}
              d={pathD}
              fill="none"
              stroke={isLow ? 'var(--da-text-tertiary)' : isHighlighted ? 'var(--da-accent)' : 'var(--da-border)'}
              strokeWidth={isHighlighted ? 2.2 : 1.4}
              strokeDasharray={isLow ? '5 4' : undefined}
              opacity={dimmed ? 0.25 : 0.92}
              markerEnd={isLow ? 'url(#da-arrow-low)' : 'url(#da-arrow-high)'}
            >
              <title>{`${edge.from}:${edge.line} imports ${edge.to} (${edge.confidence} · ${edge.kind})`}</title>
            </path>
          );
        })}

        {/* Nodes */}
        {Array.from(layout.positioned.values()).map(({ node, x, y, w, h }) => {
          const isSelected = selectedNodeId === node.id;
          const label = shortNodeLabel(node.id);
          const clipped = label.length > 22 ? `${label.slice(0, 21)}…` : label;

          return (
            <g
              key={node.id}
              transform={`translate(${x}, ${y})`}
              onClick={() => onSelectNode(node)}
              style={{ cursor: 'pointer' }}
            >
              <rect
                width={w}
                height={h}
                rx={7}
                fill={TIER_FILL[node.tier]}
                stroke={isSelected ? 'var(--da-accent)' : TIER_STROKE[node.tier]}
                strokeWidth={isSelected ? 2.4 : 1.3}
              />
              <text
                x={9}
                y={15}
                fontSize={11}
                fontWeight={isSelected ? 700 : 600}
                fill="var(--da-text-primary)"
                fontFamily="var(--da-mono)"
              >
                {clipped}
              </text>
              <text x={9} y={28} fontSize={9.5} fill="var(--da-text-tertiary)">
                {node.isTestFile ? 'TEST · ' : ''}
                {`in:${node.inDegree} out:${node.outDegree}`}
              </text>
              <title>{`${node.id} (${node.tier} · git:${node.gitStatus})`}</title>
            </g>
          );
        })}

        {/* Overflow indicators when a column has >14 nodes */}
        {layout.activeColumns.map((tier, colIdx) => {
          const extra = layout.overflowByTier.get(tier);
          if (!extra) return null;
          return (
            <text
              key={`overflow-${tier}`}
              x={layout.padX + colIdx * layout.colWidth + 6}
              y={layout.height - 10}
              fontSize={10.5}
              fontWeight={600}
              fill="var(--da-text-tertiary)"
            >
              {strings.graphOverflowMore(extra)}
            </text>
          );
        })}
      </svg>
    </div>
  );
}
