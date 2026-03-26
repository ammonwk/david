import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import * as d3 from 'd3';
import type { CodebaseTopology, TopologyNode, TopologyNodeLevel } from 'david-shared';
import { Loader2, Map as MapIcon } from 'lucide-react';

// ── Types ──────────────────────────────────────────────────

export type NodeHealthStatus = 'healthy' | 'warning' | 'critical' | 'unaudited';

export interface ActiveNodes {
  auditing: Set<string>;
  fixing: Set<string>;
  hasPR: Set<string>;
}

export interface TreemapProps {
  topology: CodebaseTopology | null;
  selectedNodes: Set<string>;
  onNodeSelect: (nodeId: string) => void;
  onNodeClick: (node: TopologyNode) => void;
  onZoomChange: (path: TopologyNode[]) => void;
  loading: boolean;
  healthByNode?: Map<string, NodeHealthStatus>;
  activeNodes?: ActiveNodes;
}

interface HierarchyDatum {
  id: string;
  name: string;
  level: TopologyNodeLevel;
  totalLines: number;
  fileCount: number;
  description: string;
  node: TopologyNode | null; // null for synthetic root
  children?: HierarchyDatum[];
}

interface TooltipState {
  visible: boolean;
  x: number;
  y: number;
  node: TopologyNode | null;
}

const compactNumber = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

function clipIdForNode(nodeId: string): string {
  return `clip-${nodeId.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

function truncateLabel(label: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (label.length <= maxChars) return label;
  return `${label.slice(0, Math.max(1, maxChars - 1))}\u2026`;
}

// ── Health color helpers ───────────────────────────────────

const HEALTH_COLORS: Record<NodeHealthStatus, { stroke: string; fill: string; solid: string }> = {
  healthy:   { stroke: 'var(--treemap-green, #22c55e)',  fill: 'var(--treemap-green-fill, rgba(34,197,94,0.18))',    solid: 'var(--treemap-green-solid, rgba(34,197,94,0.30))' },
  warning:   { stroke: 'var(--accent-amber, #f59e0b)',   fill: 'rgba(245,158,11,0.18)',                              solid: 'rgba(245,158,11,0.30)' },
  critical:  { stroke: 'var(--accent-red, #ef4444)',      fill: 'rgba(239,68,68,0.18)',                               solid: 'rgba(239,68,68,0.30)' },
  unaudited: { stroke: 'var(--treemap-gray, #64748b)',   fill: 'var(--treemap-gray-fill, rgba(100,116,139,0.25))',   solid: 'var(--treemap-gray-solid, rgba(100,116,139,0.40))' },
};

function resolveHealth(
  node: TopologyNode,
  healthMap?: Map<string, NodeHealthStatus>,
): NodeHealthStatus {
  if (healthMap?.has(node.id)) return healthMap.get(node.id)!;
  if (node.totalLines === 0 && node.files.length === 0) return 'unaudited';
  return 'healthy';
}

function getHealthColor(node: TopologyNode, healthMap?: Map<string, NodeHealthStatus>): string {
  return HEALTH_COLORS[resolveHealth(node, healthMap)].stroke;
}

function getHealthFill(node: TopologyNode, healthMap?: Map<string, NodeHealthStatus>): string {
  return HEALTH_COLORS[resolveHealth(node, healthMap)].fill;
}

function getHealthFillSolid(node: TopologyNode, healthMap?: Map<string, NodeHealthStatus>): string {
  return HEALTH_COLORS[resolveHealth(node, healthMap)].solid;
}

// ── Hierarchy builder ─────────────────────────────────────

function buildHierarchy(nodes: TopologyNode[]): HierarchyDatum {
  const nodeMap = new globalThis.Map<string, HierarchyDatum>();

  for (const n of nodes) {
    nodeMap.set(n.id, {
      id: n.id,
      name: n.name,
      level: n.level,
      totalLines: Math.max(n.totalLines, 1),
      fileCount: n.files.length,
      description: n.description,
      node: n,
      children: [],
    });
  }

  const root: HierarchyDatum = {
    id: '__root__',
    name: 'All',
    level: 1 as TopologyNodeLevel,
    totalLines: 0,
    fileCount: 0,
    description: 'Codebase root',
    node: null,
    children: [],
  };

  for (const n of nodes) {
    const datum = nodeMap.get(n.id)!;
    if (n.parentId && nodeMap.has(n.parentId)) {
      nodeMap.get(n.parentId)!.children!.push(datum);
    } else {
      root.children!.push(datum);
    }
  }

  return root;
}

// ── Component ──────────────────────────────────────────────

export function Treemap({
  topology,
  selectedNodes,
  onNodeSelect,
  onNodeClick,
  onZoomChange,
  loading,
  healthByNode,
  activeNodes,
}: TreemapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState>({
    visible: false,
    x: 0,
    y: 0,
    node: null,
  });

  // Track the current zoom path (ancestors of current root being displayed)
  const [zoomPath, setZoomPath] = useState<TopologyNode[]>([]);
  // The currently zoomed-into d3 hierarchy node
  const currentRootRef = useRef<d3.HierarchyRectangularNode<HierarchyDatum> | null>(null);
  // Full packed hierarchy ref
  const fullRootRef = useRef<d3.HierarchyRectangularNode<HierarchyDatum> | null>(null);
  // Selection ref for D3 callbacks
  const selectedRef = useRef(selectedNodes);
  selectedRef.current = selectedNodes;
  // Health map ref for D3 callbacks
  const healthRef = useRef(healthByNode);
  healthRef.current = healthByNode;
  // Active nodes ref for D3 callbacks
  const activeNodesRef = useRef(activeNodes);
  activeNodesRef.current = activeNodes;
  // Selection mode: when true, clicks toggle selection instead of zooming
  const selectionModeRef = useRef(false);

  // Expose a way to detect selection mode from selectedNodes count
  // (when Audit Selected is active, parent component will have selection mode)
  useEffect(() => {
    selectionModeRef.current = selectedNodes.size > 0;
  }, [selectedNodes]);

  // Build hierarchy from topology
  const hierarchyRoot = useMemo(() => {
    if (!topology) return null;
    const data = buildHierarchy(topology.nodes);
    const root = d3
      .hierarchy(data)
      .sum((d) => (d.children && d.children.length > 0 ? 0 : d.totalLines))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    return root;
  }, [topology]);

  const renderTreemap = useCallback(() => {
    if (!svgRef.current || !containerRef.current || !hierarchyRoot) return;

    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;

    if (width === 0 || height === 0) return;

    const svg = d3.select(svgRef.current);
    svg.attr('width', width).attr('height', height);

    // Apply treemap layout
    const treemapLayout = d3
      .treemap<HierarchyDatum>()
      .size([width, height])
      .paddingTop(28)
      .paddingRight(2)
      .paddingBottom(2)
      .paddingLeft(2)
      .paddingInner(2)
      .tile(d3.treemapSquarify.ratio(1.2));

    const layoutRoot = treemapLayout(hierarchyRoot as d3.HierarchyNode<HierarchyDatum> as any);
    fullRootRef.current = layoutRoot;

    // Determine what to render based on zoom state
    const displayRoot = currentRootRef.current || layoutRoot;

    // Calculate scale factors for zoom
    const dx = displayRoot.x1 - displayRoot.x0;
    const dy = displayRoot.y1 - displayRoot.y0;
    const scaleX = dx > 0 ? width / dx : 1;
    const scaleY = dy > 0 ? height / dy : 1;
    const offsetX = displayRoot.x0;
    const offsetY = displayRoot.y0;

    // Determine which level of children to show
    const displayDepth = displayRoot.depth;
    const maxRenderDepth = displayDepth + 3; // show up to 3 levels deep from current root

    // Get all visible descendants
    const visibleNodes = displayRoot.descendants().filter((d) => {
      if (d === displayRoot) return false;
      if (d.depth > maxRenderDepth) return false;
      return true;
    });

    const hMap = healthRef.current;
    const active = activeNodesRef.current;

    // Helper: compute cell position/size for a node
    const cellX = (d: d3.HierarchyRectangularNode<HierarchyDatum>) => (d.x0 - offsetX) * scaleX;
    const cellY = (d: d3.HierarchyRectangularNode<HierarchyDatum>) => (d.y0 - offsetY) * scaleY;
    const cellW = (d: d3.HierarchyRectangularNode<HierarchyDatum>) => Math.max(0, (d.x1 - d.x0) * scaleX);
    const cellH = (d: d3.HierarchyRectangularNode<HierarchyDatum>) => Math.max(0, (d.y1 - d.y0) * scaleY);

    const T = 600;
    const ease = d3.easeCubicInOut;

    // ── Ensure persistent structure (defs, background, main group) ──
    let defs = svg.select<SVGDefsElement>('defs');
    if (defs.empty()) defs = svg.append('defs');

    // Inject scan-dash animation into defs once
    if (defs.select('style').empty()) {
      defs.append('style').text(`
        @keyframes scan-dash { to { stroke-dashoffset: -18; } }
      `);
    }

    let g = svg.select<SVGGElement>('g.treemap-root');
    if (g.empty()) {
      g = svg.append('g').attr('class', 'treemap-root');
      g.append('rect')
        .attr('class', 'bg-rect')
        .attr('fill', 'var(--bg-secondary)')
        .attr('rx', 4);
    }
    g.select('rect.bg-rect').attr('width', width).attr('height', height);

    // ── Update clip paths ──
    const clips = defs
      .selectAll<SVGClipPathElement, d3.HierarchyRectangularNode<HierarchyDatum>>('clipPath.cell-clip')
      .data(visibleNodes, (d) => d.data.id);

    clips.exit().remove();

    const clipsEnter = clips.enter().append('clipPath').attr('class', 'cell-clip');
    clipsEnter.append('rect');

    clips.merge(clipsEnter)
      .attr('id', (d) => clipIdForNode(d.data.id))
      .select('rect')
      .attr('width', (d) => Math.max(0, cellW(d) - 4))
      .attr('height', (d) => Math.max(0, cellH(d) - 4));

    // ── Cell groups: enter / update / exit ──
    const cells = g
      .selectAll<SVGGElement, d3.HierarchyRectangularNode<HierarchyDatum>>('g.cell')
      .data(visibleNodes, (d) => d.data.id);

    // EXIT: fade out and remove
    cells.exit<d3.HierarchyRectangularNode<HierarchyDatum>>()
      .transition().duration(T).ease(ease)
      .style('opacity', 0)
      .remove();

    // ENTER: create new cell groups
    const cellsEnter = cells.enter()
      .append('g')
      .attr('class', 'cell')
      .style('cursor', 'pointer')
      .style('opacity', 0)
      .attr('transform', (d) => `translate(${cellX(d)},${cellY(d)})`);

    // Append sub-elements for entering cells
    cellsEnter.append('rect').attr('class', 'cell-rect');
    cellsEnter.append('rect').attr('class', 'selection-border')
      .attr('fill', 'none').attr('pointer-events', 'none');
    cellsEnter.append('rect').attr('class', 'header-bar')
      .attr('pointer-events', 'none');
    cellsEnter.append('text').attr('class', 'cell-label')
      .attr('pointer-events', 'none');
    cellsEnter.append('text').attr('class', 'cell-meta')
      .attr('pointer-events', 'none');
    // Activity overlay elements
    cellsEnter.append('rect').attr('class', 'audit-border')
      .attr('fill', 'none').attr('pointer-events', 'none');
    cellsEnter.append('text').attr('class', 'activity-icon')
      .attr('pointer-events', 'none');

    // Fade in entering cells
    cellsEnter.transition().duration(T).ease(ease).style('opacity', 1);

    // MERGE: update all cells (entering + existing)
    const allCells = cells.merge(cellsEnter);

    // Animate group transform
    allCells.transition().duration(T).ease(ease)
      .style('opacity', 1)
      .attr('transform', (d) => `translate(${cellX(d)},${cellY(d)})`);

    // ── Cell rectangles ──
    allCells.select<SVGRectElement>('rect.cell-rect')
      .transition().duration(T).ease(ease)
      .attr('width', (d) => cellW(d))
      .attr('height', (d) => cellH(d))
      .attr('fill', (d) => {
        if (!d.data.node) return 'var(--bg-tertiary)';
        if (d.depth > displayDepth + 1) return getHealthFillSolid(d.data.node, hMap);
        return getHealthFill(d.data.node, hMap);
      })
      .attr('stroke', (d) => {
        if (!d.data.node) return 'var(--border-color)';
        const isSelected = selectedRef.current.has(d.data.id);
        if (isSelected) return '#3b82f6';
        return getHealthColor(d.data.node, hMap);
      })
      .attr('stroke-width', (d) => {
        const isSelected = selectedRef.current.has(d.data.id);
        if (isSelected) return 3;
        if (d.depth === displayDepth + 1) return 1.5;
        return 1;
      })
      .attr('stroke-opacity', (d) => {
        const isSelected = selectedRef.current.has(d.data.id);
        if (isSelected) return 1;
        if (d.depth === displayDepth + 1) return 0.7;
        return 0.4;
      })
      .attr('rx', (d) => (d.depth === displayDepth + 1 ? 4 : 2));

    // ── Selection highlight border ──
    allCells.select<SVGRectElement>('rect.selection-border')
      .transition().duration(T).ease(ease)
      .attr('width', (d) => cellW(d))
      .attr('height', (d) => cellH(d))
      .attr('stroke', (d) => selectedRef.current.has(d.data.id) ? '#3b82f6' : 'none')
      .attr('stroke-width', (d) => selectedRef.current.has(d.data.id) ? 3 : 0)
      .attr('stroke-dasharray', '6,3')
      .attr('rx', 4);

    // ── Header bar for groups ──
    allCells.select<SVGRectElement>('rect.header-bar')
      .transition().duration(T).ease(ease)
      .attr('width', (d) => cellW(d))
      .attr('height', 26)
      .attr('fill', (d) => {
        if (!d.data.node) return 'var(--bg-tertiary)';
        return getHealthColor(d.data.node, hMap);
      })
      .attr('opacity', (d) =>
        d.depth === displayDepth + 1 && d.children && d.children.length > 0 ? 0.15 : 0,
      )
      .attr('rx', 4);

    // ── Labels ──
    allCells.select<SVGTextElement>('text.cell-label')
      .attr('x', 6)
      .attr('y', 17)
      .attr('clip-path', (d) => `url(#${clipIdForNode(d.data.id)})`)
      .attr('fill', 'var(--text-primary)')
      .attr('font-size', (d) => {
        const w = cellW(d);
        if (d.depth === displayDepth + 1) return `${Math.min(13, Math.max(10, w / 12))}px`;
        return `${Math.min(11, Math.max(9, w / 14))}px`;
      })
      .attr('font-weight', (d) => (d.depth === displayDepth + 1 ? '600' : '500'))
      .text((d) => {
        const w = cellW(d);
        const h = cellH(d);
        if (w <= 50 || h <= 24) return '';
        let metaText = '';
        if (w > 210) {
          metaText = `${d.data.fileCount.toLocaleString()} file${d.data.fileCount !== 1 ? 's' : ''} · ${d.data.totalLines.toLocaleString()} lines`;
        } else if (w > 150) {
          metaText = `${d.data.fileCount.toLocaleString()}f · ${compactNumber.format(d.data.totalLines)} lines`;
        } else if (w > 110) {
          metaText = `${compactNumber.format(d.data.totalLines)} lines`;
        }
        const reservedWidth = metaText ? Math.min(w * 0.5, metaText.length * 6 + 16) : 0;
        const maxChars = Math.floor((w - 12 - reservedWidth) / 7);
        return truncateLabel(d.data.name, maxChars);
      })
      .transition().duration(T).ease(ease)
      .attr('opacity', (d) => (cellW(d) > 50 && cellH(d) > 24 ? 0.96 : 0));

    // ── Inline metadata: file and line counts ──
    allCells.select<SVGTextElement>('text.cell-meta')
      .attr('x', (d) => Math.max(6, cellW(d) - 6))
      .attr('y', 17)
      .attr('clip-path', (d) => `url(#${clipIdForNode(d.data.id)})`)
      .attr('text-anchor', 'end')
      .attr('fill', 'var(--text-secondary)')
      .attr('font-size', (d) => (d.depth === displayDepth + 1 ? '10px' : '9px'))
      .attr('font-weight', '500')
      .text((d) => {
        const w = cellW(d);
        const h = cellH(d);
        if (w <= 110 || h <= 24) return '';
        const fc = d.data.fileCount;
        const lines = d.data.totalLines;
        if (w > 210) return `${fc.toLocaleString()} file${fc !== 1 ? 's' : ''} · ${lines.toLocaleString()} lines`;
        if (w > 150) return `${fc.toLocaleString()}f · ${compactNumber.format(lines)} lines`;
        return `${compactNumber.format(lines)} lines`;
      })
      .transition().duration(T).ease(ease)
      .attr('opacity', (d) => (cellW(d) > 110 && cellH(d) > 24 ? 0.88 : 0));

    // ── Activity overlay: animated audit border ──
    allCells.select<SVGRectElement>('rect.audit-border')
      .attr('width', (d) => cellW(d))
      .attr('height', (d) => cellH(d))
      .attr('rx', 4)
      .attr('stroke', (d) => active?.auditing.has(d.data.id) ? '#3b82f6' : 'none')
      .attr('stroke-width', (d) => active?.auditing.has(d.data.id) ? 2 : 0)
      .attr('stroke-dasharray', '6,3')
      .style('animation', (d) =>
        active?.auditing.has(d.data.id) ? 'scan-dash 1.5s linear infinite' : 'none',
      );

    // ── Activity overlay: wrench / PR icon ──
    allCells.select<SVGTextElement>('text.activity-icon')
      .attr('x', (d) => cellW(d) - 16)
      .attr('y', 15)
      .attr('font-size', '12px')
      .attr('fill', (d) => {
        if (active?.fixing.has(d.data.id)) return 'var(--accent-amber, #f59e0b)';
        if (active?.hasPR.has(d.data.id)) return 'var(--treemap-green, #22c55e)';
        return 'none';
      })
      .text((d) => {
        if (active?.fixing.has(d.data.id)) return '\u{1F527}';
        if (active?.hasPR.has(d.data.id)) return '\u{1F4E4}';
        return '';
      })
      .attr('opacity', (d) =>
        (active?.fixing.has(d.data.id) || active?.hasPR.has(d.data.id)) && cellW(d) > 30 ? 1 : 0,
      );

    // ── Interactions ──

    // Hover
    allCells
      .on('mouseenter', function (event, d) {
        if (!d.data.node) return;

        d3.select(this)
          .select('rect.cell-rect')
          .transition()
          .duration(150)
          .attr('stroke-opacity', 1)
          .attr('stroke-width', d.depth === displayDepth + 1 ? 2.5 : 2);

        const [mx, my] = d3.pointer(event, container);
        setTooltip({ visible: true, x: mx, y: my, node: d.data.node });
      })
      .on('mousemove', function (event) {
        const [mx, my] = d3.pointer(event, container);
        setTooltip((prev) => ({ ...prev, x: mx, y: my }));
      })
      .on('mouseleave', function (_, d) {
        if (!d.data.node) return;

        const isSelected = selectedRef.current.has(d.data.id);
        d3.select(this)
          .select('rect.cell-rect')
          .transition()
          .duration(150)
          .attr('stroke-opacity', isSelected ? 1 : d.depth === displayDepth + 1 ? 0.7 : 0.4)
          .attr('stroke-width', isSelected ? 3 : d.depth === displayDepth + 1 ? 1.5 : 1);

        setTooltip((prev) => ({ ...prev, visible: false }));
      });

    // Click
    allCells.on('click', function (event, d) {
      if (!d.data.node) return;
      event.stopPropagation();

      // If in selection mode, toggle selection
      if (selectionModeRef.current) {
        onNodeSelect(d.data.id);
        return;
      }

      // If this node has children, zoom into it
      if (d.children && d.children.length > 0) {
        // Build zoom path
        const path: TopologyNode[] = [];
        let ancestor: d3.HierarchyRectangularNode<HierarchyDatum> | null = d;
        while (ancestor && ancestor.data.node) {
          path.unshift(ancestor.data.node);
          ancestor = ancestor.parent;
        }

        currentRootRef.current = d;
        setZoomPath(path);
        onZoomChange(path);

        // Also open detail for the node
        onNodeClick(d.data.node);
      } else {
        // Leaf node: open detail drawer
        onNodeClick(d.data.node);
      }
    });

    // Click on background to zoom back to root
    svg.on('click', () => {
      // Only zoom out if currently zoomed in
      if (currentRootRef.current) {
        currentRootRef.current = null;
        setZoomPath([]);
        onZoomChange([]);
      }
    });
  }, [hierarchyRoot, onNodeSelect, onNodeClick, onZoomChange]);

  // Navigate to a specific node in the zoom path (breadcrumb click)
  const navigateToPathIndex = useCallback(
    (index: number) => {
      if (!fullRootRef.current) return;

      if (index < 0) {
        // Navigate to root
        currentRootRef.current = null;
        setZoomPath([]);
        onZoomChange([]);
        return;
      }

      const targetNode = zoomPath[index];
      if (!targetNode) return;

      // Find the corresponding d3 hierarchy node
      const found = fullRootRef.current.descendants().find(
        (d) => d.data.id === targetNode.id,
      );

      if (found) {
        const newPath = zoomPath.slice(0, index + 1);
        currentRootRef.current = found;
        setZoomPath(newPath);
        onZoomChange(newPath);
      }
    },
    [zoomPath, onZoomChange],
  );

  // Re-render when zoom path or topology changes
  useEffect(() => {
    renderTreemap();
  }, [renderTreemap, zoomPath]);

  // Re-render on resize
  useEffect(() => {
    renderTreemap();

    const observer = new ResizeObserver(() => {
      renderTreemap();
    });

    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => observer.disconnect();
  }, [renderTreemap]);

  // Re-render when selection changes
  useEffect(() => {
    renderTreemap();
  }, [selectedNodes, renderTreemap]);

  // ── Loading state ──
  if (loading) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <div className="h-24 w-24 rounded-lg border-2 border-[var(--border-color)]" />
            <div className="absolute inset-0 h-24 w-24 animate-spin-slow rounded-lg border-2 border-transparent border-t-blue-500" />
            <Loader2 className="absolute left-1/2 top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2 animate-spin text-blue-400" />
          </div>
          <div className="text-sm text-[var(--text-muted)]">Loading topology...</div>
          {/* Shimmer skeleton rectangles */}
          <div className="flex gap-2 opacity-20">
            {[
              { w: 60, h: 40 },
              { w: 44, h: 44 },
              { w: 52, h: 32 },
              { w: 36, h: 48 },
              { w: 48, h: 36 },
            ].map((size, i) => (
              <div
                key={i}
                className="animate-pulse-slow rounded bg-[var(--border-color)]"
                style={{
                  width: size.w,
                  height: size.h,
                  animationDelay: `${i * 200}ms`,
                }}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── Empty state ──
  if (!topology) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <div className="flex max-w-md flex-col items-center gap-6 text-center">
          <div className="relative">
            <div className="flex h-28 w-28 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500/10 to-purple-500/10 ring-1 ring-blue-500/20">
              <MapIcon className="h-12 w-12 text-blue-400/60" strokeWidth={1.5} />
            </div>
            <div className="absolute -bottom-1 -right-1 flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--bg-tertiary)] text-xs font-bold text-[var(--text-muted)] ring-2 ring-[var(--bg-primary)]">
              ?
            </div>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-[var(--text-primary)]">
              No Codebase Map Yet
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
              Map your repository to generate an interactive treemap.
              David will analyze the codebase structure and create a
              hierarchical map of areas, modules, and components.
            </p>
          </div>
          <p className="text-xs text-[var(--text-muted)]">
            Use the "Re-map Codebase" button above to get started
          </p>
        </div>
      </div>
    );
  }

  // ── Main treemap ──
  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden">
      {/* Breadcrumb trail */}
      {zoomPath.length > 0 && (
        <div className="flex items-center gap-1 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-2 text-sm">
          <button
            onClick={() => navigateToPathIndex(-1)}
            className="rounded px-1.5 py-0.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
          >
            All
          </button>
          {zoomPath.map((node, i) => (
            <span key={node.id} className="flex items-center gap-1">
              <span className="text-[var(--text-muted)]">&gt;</span>
              <button
                onClick={() => navigateToPathIndex(i)}
                className={`rounded px-1.5 py-0.5 transition-colors hover:bg-[var(--bg-tertiary)] ${
                  i === zoomPath.length - 1
                    ? 'font-medium text-[var(--text-primary)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                }`}
              >
                {node.name}
              </button>
            </span>
          ))}
        </div>
      )}

      {/* SVG container */}
      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden">
        <svg
          ref={svgRef}
          className="h-full w-full"
          style={{ background: 'transparent' }}
        />

        {/* Tooltip */}
        {tooltip.visible && tooltip.node && (
          <div
            className="pointer-events-none absolute z-50 animate-fade-in rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]/95 px-3 py-2.5 shadow-xl shadow-black/30 backdrop-blur-sm"
            style={{
              left: Math.min(tooltip.x + 14, (containerRef.current?.clientWidth ?? 400) - 280),
              top: Math.max(tooltip.y - 10, 4),
              maxWidth: 280,
            }}
          >
            <div className="flex items-center gap-2">
              <span
                className="inline-block h-2.5 w-2.5 rounded"
                style={{
                  background: HEALTH_COLORS[resolveHealth(tooltip.node, healthByNode)].stroke,
                }}
              />
              <span className="text-sm font-semibold text-[var(--text-primary)]">
                {tooltip.node.name}
              </span>
              <span className="rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--text-muted)]">
                L{tooltip.node.level}
              </span>
            </div>
            {tooltip.node.description && (
              <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">
                {tooltip.node.description.length > 120
                  ? tooltip.node.description.slice(0, 117) + '...'
                  : tooltip.node.description}
              </p>
            )}
            <div className="mt-1.5 flex gap-3 text-[10px] text-[var(--text-muted)]">
              <span>{tooltip.node.files.length} files</span>
              <span>{tooltip.node.totalLines.toLocaleString()} lines</span>
              {tooltip.node.children.length > 0 && (
                <span>{tooltip.node.children.length} children</span>
              )}
            </div>
          </div>
        )}

        {/* Zoom hint */}
        <div className="absolute bottom-3 right-3 rounded-md bg-[var(--bg-secondary)]/80 px-2.5 py-1.5 text-[10px] text-[var(--text-muted)] backdrop-blur-sm ring-1 ring-[var(--border-color)]">
          Click group to zoom in &middot; Breadcrumb to zoom out &middot; Click leaf for details
        </div>
      </div>
    </div>
  );
}
