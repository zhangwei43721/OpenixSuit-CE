import { useLayoutEffect, useRef, useState, type PointerEvent } from "react";

// 统一图表：按容器实际像素宽度 1:1 渲染（viewBox = 实际宽高），
// 卡片缩放时折线重新排布，字号/线宽保持固定，不再整体机械缩放。
export function MonitorLineChart({
  id,
  series,
  sampleTimes,
  locale,
  max,
  labelFor,
  formatValue,
  height = 84,
}: {
  id: string;
  series: {
    label: string;
    values: number[];
    color: string;
    strokeWidth?: number;
    dashed?: boolean;
    area?: boolean;
  }[];
  sampleTimes: number[];
  locale: string;
  max: number;
  labelFor: (value: number) => string;
  formatValue: (value: number) => string;
  height?: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () =>
      setW((prev) => (Math.abs(prev - el.clientWidth) > 1 ? el.clientWidth : prev));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const svgW = Math.max(w, 1);
  const svgH = height;
  const padX = Math.min(8, svgW / 2);
  const padY = 10;
  const plotWidth = svgW - padX * 2;
  const safeMax = max > 0 ? max : 1;
  const areaColor = series.find((s) => s.area)?.color ?? series[0]?.color ?? "#0ea5e9";

  const xOf = (index: number, count: number) =>
    padX + (count > 1 ? (index / (count - 1)) * plotWidth : 0);
  const yOf = (v: number) => {
    const t = Math.min(100, Math.max(0, (v / safeMax) * 100));
    return padY + (svgH - padY * 2) * (1 - t / 100);
  };
  const pointsOf = (values: number[]) =>
    values
      .map((v, i) => `${xOf(i, values.length).toFixed(1)},${yOf(v).toFixed(1)}`)
      .join(" ");
  const areaOf = (values: number[]) => {
    if (values.length === 0) return "";
    const baseY = svgH - padY;
    return `M ${padX},${baseY} L ${pointsOf(values).replace(/ /g, " L ")} L ${svgW - padX},${baseY} Z`;
  };

  const clearPointer = () => setPointer(null);
  const trackPointer = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width > 0) {
      setPointer({
        x: (event.clientX - bounds.left) / bounds.width,
        y: event.clientY - bounds.top,
      });
    }
  };
  const pointerX = pointer === null ? null : pointer.x * svgW;
  const sampleFraction = pointerX === null ? null
    : Math.min(1, Math.max(0, (pointerX - padX) / Math.max(1, plotWidth)));
  const sampleIndex = sampleFraction === null || sampleTimes.length === 0
    ? null
    : Math.round((sampleTimes.length - 1) * sampleFraction);
  const hoverX = sampleIndex === null ? 0 : xOf(sampleIndex, sampleTimes.length);
  const tooltipWidth = Math.min(168, svgW);
  const tooltipLeft = Math.max(0, Math.min(svgW - tooltipWidth, (pointerX ?? 0) - tooltipWidth / 2));

  return (
    <div ref={wrapRef} className="relative w-full">
      {w > 0 && (
        <svg
          width={svgW}
          height={svgH}
          viewBox={`0 0 ${svgW} ${svgH}`}
          className={`block overflow-visible ${sampleTimes.length > 0 ? "cursor-crosshair" : ""}`}
          onPointerMove={trackPointer}
          onPointerLeave={clearPointer}
          onPointerCancel={clearPointer}
        >
          <defs>
            <linearGradient id={`${id}Grad`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={areaColor} stopOpacity="0.35" />
              <stop offset="100%" stopColor={areaColor} stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {[0, 25, 50, 75, 100].map((pct) => {
            const y = padY + (svgH - padY * 2) * (1 - pct / 100);
            return (
              <g key={pct}>
                <line
                  x1={padX}
                  y1={y}
                  x2={svgW - padX}
                  y2={y}
                  stroke="currentColor"
                  className="text-slate-200 dark:text-slate-800"
                  strokeDasharray="3 3"
                />
                <text
                  x={padX + 2}
                  y={y - 3}
                  fontSize="9"
                  className="fill-slate-400 dark:fill-slate-600 font-mono"
                >
                  {labelFor((max * pct) / 100)}
                </text>
              </g>
            );
          })}
          {series.map((s, i) =>
            s.values.length === 0 ? null : (
              <g key={i}>
                {s.area && <path d={areaOf(s.values)} fill={`url(#${id}Grad)`} />}
                <polyline
                  fill="none"
                  stroke={s.color}
                  strokeWidth={s.strokeWidth ?? 1.4}
                  strokeDasharray={s.dashed ? "4 2" : undefined}
                  strokeOpacity={s.area ? 1 : 0.85}
                  strokeLinejoin="round"
                  points={pointsOf(s.values)}
                />
              </g>
            )
          )}
          {sampleIndex !== null && (
            <g pointerEvents="none">
              <line
                x1={hoverX}
                x2={hoverX}
                y1={padY}
                y2={svgH - padY}
                stroke="currentColor"
                strokeDasharray="3 3"
                className="text-slate-400 dark:text-slate-500"
              />
              {series.map(({ label, values, color }) => (
                <circle
                  key={label}
                  cx={hoverX}
                  cy={yOf(values[sampleIndex])}
                  r="3"
                  fill={color}
                  strokeWidth="1"
                  className="stroke-white dark:stroke-slate-900"
                />
              ))}
            </g>
          )}
        </svg>
      )}
      {sampleIndex !== null && pointer !== null && (
        <div
          role="tooltip"
          style={{ left: tooltipLeft, top: pointer.y - 8, width: tooltipWidth }}
          className="pointer-events-none absolute z-20 -translate-y-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] text-slate-700 shadow-md dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
        >
          <time className="mb-1 block font-mono font-semibold tabular-nums">
            {new Date(sampleTimes[sampleIndex]).toLocaleTimeString(locale, { hour12: false })}
          </time>
          <dl className="space-y-0.5">
            {series.map(({ label, values, color }) => (
              <div key={label} className="flex items-center justify-between gap-2">
                <dt className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                  {label}
                </dt>
                <dd className="whitespace-nowrap font-mono tabular-nums">{formatValue(values[sampleIndex])}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}
