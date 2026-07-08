import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { useEffect, useRef, useState } from "preact/hooks";
import { useLocation } from "wouter-preact";
import { fetchBuckets, fetchGraph, type GraphData } from "../api";
import { useAsync } from "../hooks";

interface SimNode extends SimulationNodeDatum {
  key: string;
  title: string;
  topTag: string;
  degree: number;
  stale: boolean;
}

type SimLink = SimulationLinkDatum<SimNode>;

interface LegendItem {
  tag: string;
  color: string;
}

const PALETTE = [
  "#4e79a7",
  "#f28e2b",
  "#59a14f",
  "#e15759",
  "#b07aa1",
  "#76b7b2",
  "#edc948",
  "#ff9da7",
  "#9c755f",
  "#6b9ac4",
];
const GRAY = "#8a8f98";
const NO_TAG = "（タグなし）";
const SVG_NS = "http://www.w3.org/2000/svg";

function radiusOf(degree: number): number {
  return 4 + Math.sqrt(degree) * 2.5;
}

/** d3-force シミュレーションを組み、SVG に直接描画する。戻り値はクリーンアップ関数 */
function setupGraph(
  svg: SVGSVGElement,
  data: GraphData,
  showIsolated: boolean,
  navigate: (to: string) => void,
  setLegend: (items: LegendItem[]) => void,
): () => void {
  const rect0 = svg.getBoundingClientRect();
  const width = Math.max(rect0.width, 320);
  const height = Math.max(rect0.height, 320);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.textContent = "";
  const root = document.createElementNS(SVG_NS, "g");
  svg.appendChild(root);

  const nodes: SimNode[] = data.nodes
    .filter((n) => showIsolated || n.degree > 0)
    .map((n) => ({
      key: n.key,
      title: n.title,
      topTag: n.tags[0]?.split("/")[0] ?? NO_TAG,
      degree: n.degree,
      stale: n.stale,
    }));
  const keySet = new Set(nodes.map((n) => n.key));
  const links: SimLink[] = data.edges
    .filter((e) => keySet.has(e.source) && keySet.has(e.target))
    .map((e) => ({ source: e.source, target: e.target }));

  // トップレベルタグで色分け（出現数の多い順にパレット割当）
  const tagCounts = new Map<string, number>();
  for (const n of nodes) tagCounts.set(n.topTag, (tagCounts.get(n.topTag) ?? 0) + 1);
  const sortedTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  const colorOf = new Map<string, string>();
  let paletteIndex = 0;
  for (const t of sortedTags) {
    if (t === NO_TAG) {
      colorOf.set(t, GRAY);
    } else {
      colorOf.set(t, PALETTE[paletteIndex % PALETTE.length] ?? GRAY);
      paletteIndex += 1;
    }
  }
  setLegend(sortedTags.map((t) => ({ tag: t, color: colorOf.get(t) ?? GRAY })));

  const edgeGroup = document.createElementNS(SVG_NS, "g");
  edgeGroup.setAttribute("class", "graph-edges");
  const nodeGroup = document.createElementNS(SVG_NS, "g");
  nodeGroup.setAttribute("class", "graph-nodes");
  root.append(edgeGroup, nodeGroup);

  const lineEls = links.map(() => {
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("class", "graph-edge");
    edgeGroup.appendChild(line);
    return line;
  });

  const labelAll = nodes.length <= 120;
  const nodeEls = nodes.map((n) => {
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", n.stale ? "graph-node stale" : "graph-node");
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("r", String(radiusOf(n.degree)));
    circle.setAttribute("fill", colorOf.get(n.topTag) ?? GRAY);
    g.appendChild(circle);
    if (labelAll || n.degree >= 2) {
      const label = document.createElementNS(SVG_NS, "text");
      label.textContent = n.title.length > 14 ? `${n.title.slice(0, 14)}…` : n.title;
      label.setAttribute("y", String(-(radiusOf(n.degree) + 4)));
      g.appendChild(label);
    }
    const tooltip = document.createElementNS(SVG_NS, "title");
    tooltip.textContent = `${n.title}${n.stale ? "（陳腐化候補）" : ""}`;
    g.appendChild(tooltip);
    nodeGroup.appendChild(g);
    return g;
  });

  const sim = forceSimulation(nodes)
    .force(
      "link",
      forceLink<SimNode, SimLink>(links)
        .id((d) => d.key)
        .distance(70),
    )
    .force("charge", forceManyBody().strength(-160))
    .force("center", forceCenter(width / 2, height / 2));

  sim.on("tick", () => {
    links.forEach((l, i) => {
      const el = lineEls[i];
      const s = l.source as SimNode;
      const t = l.target as SimNode;
      if (!el) return;
      el.setAttribute("x1", String(s.x ?? 0));
      el.setAttribute("y1", String(s.y ?? 0));
      el.setAttribute("x2", String(t.x ?? 0));
      el.setAttribute("y2", String(t.y ?? 0));
    });
    nodes.forEach((n, i) => {
      nodeEls[i]?.setAttribute("transform", `translate(${n.x ?? 0},${n.y ?? 0})`);
    });
  });

  // ズーム（wheel）・パン（背景ドラッグ）・ノードドラッグの簡易実装
  let scale = 1;
  let tx = 0;
  let ty = 0;
  const applyTransform = () => {
    root.setAttribute("transform", `translate(${tx},${ty}) scale(${scale})`);
  };

  const toView = (clientX: number, clientY: number) => {
    const rect = svg.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * width,
      y: ((clientY - rect.top) / rect.height) * height,
    };
  };
  const toGraph = (clientX: number, clientY: number) => {
    const v = toView(clientX, clientY);
    return { x: (v.x - tx) / scale, y: (v.y - ty) / scale };
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const next = Math.min(Math.max(scale * Math.exp(-e.deltaY * 0.002), 0.2), 5);
    const v = toView(e.clientX, e.clientY);
    tx = v.x - ((v.x - tx) / scale) * next;
    ty = v.y - ((v.y - ty) / scale) * next;
    scale = next;
    applyTransform();
  };

  const findNode = (gx: number, gy: number): SimNode | null => {
    let best: SimNode | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const n of nodes) {
      const r = radiusOf(n.degree) + 4;
      const dx = (n.x ?? 0) - gx;
      const dy = (n.y ?? 0) - gy;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r * r && d2 < bestDist) {
        best = n;
        bestDist = d2;
      }
    }
    return best;
  };

  interface DragState {
    node: SimNode | null;
    startX: number;
    startY: number;
    baseTx: number;
    baseTy: number;
    moved: boolean;
  }
  let drag: DragState | null = null;

  const onPointerDown = (e: PointerEvent) => {
    const p = toGraph(e.clientX, e.clientY);
    const node = findNode(p.x, p.y);
    drag = { node, startX: e.clientX, startY: e.clientY, baseTx: tx, baseTy: ty, moved: false };
    if (node) {
      node.fx = node.x;
      node.fy = node.y;
      sim.alphaTarget(0.3).restart();
    }
    svg.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (drag.node) {
      const p = toGraph(e.clientX, e.clientY);
      drag.node.fx = p.x;
      drag.node.fy = p.y;
    } else if (drag.moved) {
      const rect = svg.getBoundingClientRect();
      tx = drag.baseTx + (dx / rect.width) * width;
      ty = drag.baseTy + (dy / rect.height) * height;
      applyTransform();
    }
  };

  const onPointerUp = () => {
    if (!drag) return;
    const { node, moved } = drag;
    drag = null;
    if (!node) return;
    node.fx = null;
    node.fy = null;
    sim.alphaTarget(0);
    if (!moved) navigate(`/docs/${encodeURIComponent(node.key)}`);
  };

  svg.addEventListener("wheel", onWheel, { passive: false });
  svg.addEventListener("pointerdown", onPointerDown);
  svg.addEventListener("pointermove", onPointerMove);
  svg.addEventListener("pointerup", onPointerUp);
  applyTransform();

  return () => {
    sim.stop();
    svg.removeEventListener("wheel", onWheel);
    svg.removeEventListener("pointerdown", onPointerDown);
    svg.removeEventListener("pointermove", onPointerMove);
    svg.removeEventListener("pointerup", onPointerUp);
    svg.textContent = "";
  };
}

export function GraphPage() {
  const [, navigate] = useLocation();
  const [bucket, setBucket] = useState("");
  const [showIsolated, setShowIsolated] = useState(true);
  const [legend, setLegend] = useState<LegendItem[]>([]);
  const buckets = useAsync(fetchBuckets, []);
  const graph = useAsync(() => fetchGraph({ bucket: bucket || undefined }), [bucket]);

  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !graph.data) return;
    return setupGraph(svg, graph.data, showIsolated, navigate, setLegend);
  }, [graph.data, showIsolated, navigate]);

  return (
    <div class="page graph-page">
      <h1>ナレッジグラフ</h1>
      <div class="filter-bar">
        <label>
          Bucket:
          <select value={bucket} onChange={(e) => setBucket((e.target as HTMLSelectElement).value)}>
            <option value="">すべて</option>
            {(buckets.data ?? []).map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label class="checkbox-label">
          <input
            type="checkbox"
            checked={showIsolated}
            onChange={(e) => setShowIsolated((e.target as HTMLInputElement).checked)}
          />
          孤立ノードを表示
        </label>
        {graph.data && (
          <span class="muted">
            ノード {graph.data.nodes.length} / エッジ {graph.data.edges.length}
          </span>
        )}
      </div>
      {graph.error && <p class="error">{graph.error}</p>}
      <div class="graph-wrap">
        <svg class="graph-svg" ref={svgRef} />
        {legend.length > 0 && (
          <div class="graph-legend">
            {legend.map((l) => (
              <span key={l.tag} class="legend-item">
                <span class="swatch" style={{ background: l.color }} />
                {l.tag}
              </span>
            ))}
          </div>
        )}
      </div>
      <p class="muted">
        ドラッグで移動、ホイールでズーム、ノードクリックで詳細へ。薄いノードは陳腐化候補です。
      </p>
    </div>
  );
}
