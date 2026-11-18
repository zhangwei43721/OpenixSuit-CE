import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import {
  ArrowLeft,
  Camera,
  Home,
  LayoutGrid,
  MonitorSmartphone,
  Power,
  RefreshCw,
  Volume1,
  Volume2,
} from "lucide-react";
import { useTranslation } from "react-i18next";

interface AdbScreenPageProps {
  serial: string;
  onLog: (msg: string) => void;
}

interface ScreenResolution {
  width: number;
  height: number;
}

interface PointerStart {
  clientX: number;
  clientY: number;
  deviceX: number;
  deviceY: number;
  timeMs: number;
}

function base64ToUint8Array(dataUrlOrBase64: string): Uint8Array {
  const b64 = dataUrlOrBase64.includes(",")
    ? dataUrlOrBase64.split(",")[1]
    : dataUrlOrBase64;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes: number[] | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < arr.length; i += chunkSize) {
    binary += String.fromCharCode(...arr.subarray(i, i + chunkSize));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

export function AdbScreenPage({ serial, onLog }: AdbScreenPageProps) {
  const { i18n } = useTranslation();
  const isEn = i18n.language.startsWith("en");

  const [resolution, setResolution] = useState<ScreenResolution | null>(null);
  const [imageSrc, setImageSrc] = useState<string>("");
  const [intervalMs, setIntervalMs] = useState<number>(0); // 0 = Manual, 1000 = 1s, 2000 = 2s
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastGesture, setLastGesture] = useState<string>("");
  const [tapMarker, setTapMarker] = useState<{ xPct: number; yPct: number } | null>(null);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const pointerStartRef = useRef<PointerStart | null>(null);
  const capturingRef = useRef(false);
  const onLogRef = useRef(onLog);
  onLogRef.current = onLog;
  const lastErrRef = useRef<string | null>(null);

  const fetchScreenInfo = useCallback(async () => {
    if (!serial) return;
    try {
      const info = await invoke<ScreenResolution | string>("adb_screen_info", { serial });
      if (typeof info === "string") {
        const m = info.match(/(\d+)\s*[xX×]\s*(\d+)/);
        if (m) {
          setResolution({ width: Number(m[1]), height: Number(m[2]) });
        }
      } else if (info && typeof info.width === "number" && typeof info.height === "number") {
        setResolution({ width: info.width, height: info.height });
      }
    } catch (err) {
      onLogRef.current(`adb_screen_info error: ${String(err)}`);
    }
  }, [serial]);

  const captureScreen = useCallback(async () => {
    if (!serial || capturingRef.current) return;
    capturingRef.current = true;
    setLoading(true);
    try {
      const res = await invoke<string | number[]>("adb_screencap_png", { serial });
      let dataUrl = "";
      if (typeof res === "string") {
        dataUrl = res.startsWith("data:image/") ? res : `data:image/png;base64,${res}`;
      } else if (Array.isArray(res)) {
        dataUrl = uint8ArrayToBase64(res);
      }
      if (dataUrl) {
        setImageSrc(dataUrl);
      }
      setError(null);
      lastErrRef.current = null;
    } catch (err) {
      const msg = String(err);
      setError(msg);
      if (lastErrRef.current !== msg) {
        lastErrRef.current = msg;
        onLogRef.current(`adb_screencap_png error: ${msg}`);
      }
    } finally {
      capturingRef.current = false;
      setLoading(false);
    }
  }, [serial]);

  useEffect(() => {
    setImageSrc("");
    setResolution(null);
    lastErrRef.current = null;
    setError(null);
    if (serial) {
      fetchScreenInfo();
      captureScreen();
    }
  }, [serial, fetchScreenInfo, captureScreen]);

  useEffect(() => {
    if (!serial || intervalMs <= 0) return;
    const timer = setInterval(() => {
      captureScreen();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [serial, intervalMs, captureScreen]);

  const mapPointerToDevice = (
    clientX: number,
    clientY: number
  ): { deviceX: number; deviceY: number; xPct: number; yPct: number } | null => {
    const img = imgRef.current;
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const targetW = img.naturalWidth || resolution?.width || 0;
    const targetH = img.naturalHeight || resolution?.height || 0;
    if (targetW <= 0 || targetH <= 0) return null;

    const relX = Math.min(Math.max(0, clientX - rect.left), rect.width);
    const relY = Math.min(Math.max(0, clientY - rect.top), rect.height);

    const deviceX = Math.round((relX / rect.width) * targetW);
    const deviceY = Math.round((relY / rect.height) * targetH);

    return {
      deviceX,
      deviceY,
      xPct: (relX / rect.width) * 100,
      yPct: (relY / rect.height) * 100,
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
    if (!serial || e.button !== 0) return;
    const mapped = mapPointerToDevice(e.clientX, e.clientY);
    if (!mapped) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointerStartRef.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      deviceX: mapped.deviceX,
      deviceY: mapped.deviceY,
      timeMs: Date.now(),
    };
  };

  const handlePointerUp = async (e: React.PointerEvent<HTMLImageElement>) => {
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    if (!start || !serial) return;

    const mapped = mapPointerToDevice(e.clientX, e.clientY);
    if (!mapped) return;

    const dist = Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY);
    const durationMs = Math.max(80, Math.min(2000, Date.now() - start.timeMs));

    try {
      if (dist < 8) {
        setTapMarker({ xPct: mapped.xPct, yPct: mapped.yPct });
        setTimeout(() => setTapMarker(null), 400);
        setLastGesture(`Tap (${mapped.deviceX}, ${mapped.deviceY})`);
        await invoke("adb_input_tap", {
          serial,
          x: mapped.deviceX,
          y: mapped.deviceY,
        });
      } else {
        setLastGesture(
          `Swipe (${start.deviceX},${start.deviceY}) -> (${mapped.deviceX},${mapped.deviceY}) [${durationMs}ms]`
        );
        await invoke("adb_input_swipe", {
          serial,
          x1: start.deviceX,
          y1: start.deviceY,
          x2: mapped.deviceX,
          y2: mapped.deviceY,
          durationMs,
        });
      }
      setTimeout(() => {
        captureScreen();
      }, 260);
    } catch (err) {
      const msg = String(err);
      setError(msg);
      onLog(`adb_input error: ${msg}`);
    }
  };

  const sendKeyEvent = async (keycode: number, label: string) => {
    if (!serial) return;
    try {
      setLastGesture(`KeyEvent ${label} (${keycode})`);
      await invoke("adb_input_keyevent", { serial, keycode });
      setTimeout(() => {
        captureScreen();
      }, 260);
    } catch (err) {
      const msg = String(err);
      setError(msg);
      onLog(`adb_input_keyevent error: ${msg}`);
    }
  };

  const handleExportScreenshot = async () => {
    if (!imageSrc) return;
    try {
      const path = await save({
        defaultPath: `screencap_${serial || "device"}_${Date.now()}.png`,
        filters: [{ name: "PNG Image", extensions: ["png"] }],
      });
      if (path) {
        await writeFile(path, base64ToUint8Array(imageSrc));
        onLog(isEn ? `Saved screenshot: ${path}` : `已导出截图: ${path}`);
      }
    } catch (err) {
      onLog(`Save screenshot error: ${String(err)}`);
    }
  };

  const displayRes =
    resolution ||
    (imgRef.current?.naturalWidth
      ? { width: imgRef.current.naturalWidth, height: imgRef.current.naturalHeight }
      : null);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* Top Toolbar */}
      <div className="ui-toolbar">
        <div className="flex flex-wrap items-center gap-2">
          <div className="ui-title">
            <MonitorSmartphone className="h-4 w-4 text-blue-500" />
            <span>{isEn ? "ADB Screen Mirror" : "ADB 屏幕控制"}</span>
          </div>

          <span
            className={`rounded-md border px-2 py-0.5 font-mono text-xs tabular-nums ${
              serial
                ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "border-slate-200 bg-slate-100 text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400"
            }`}
          >
            {serial || (isEn ? "No Device" : "未连接")}
          </span>

          {displayRes && (
            <span className="rounded-md border border-slate-200 bg-slate-100 px-2 py-0.5 font-mono text-xs tabular-nums text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
              {displayRes.width} × {displayRes.height}
            </span>
          )}

          {lastGesture && (
            <span className="hidden font-mono text-[11px] tabular-nums text-slate-400 md:inline-block">
              {lastGesture}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Auto refresh interval */}
          <div className="ui-segmented">
            {[
              { label: isEn ? "Manual" : "手动", value: 0 },
              { label: "1s", value: 1000 },
              { label: "2s", value: 2000 },
            ].map((opt) => (
              <button
                key={opt.value}
                onClick={() => setIntervalMs(opt.value)}
                className={`ui-segmented-btn ${
                  intervalMs === opt.value
                    ? "bg-blue-600 text-white shadow-sm"
                    : "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <button
            onClick={captureScreen}
            disabled={!serial || loading}
            className="ui-btn-secondary"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            {isEn ? "Refresh" : "刷新画面"}
          </button>

          <button
            onClick={handleExportScreenshot}
            disabled={!imageSrc}
            className="ui-btn-primary"
          >
            <Camera className="h-3.5 w-3.5" />
            {isEn ? "Export PNG" : "导出截图"}
          </button>
        </div>
      </div>

      {/* Hardware Key Buttons */}
      <div className="ui-card flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">
            {isEn ? "Hardware Keys:" : "实体按键:"}
          </span>
          <button
            onClick={() => sendKeyEvent(4, "Back")}
            disabled={!serial}
            className="ui-btn-secondary !px-2.5 !py-1"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </button>
          <button
            onClick={() => sendKeyEvent(3, "Home")}
            disabled={!serial}
            className="ui-btn-secondary !px-2.5 !py-1"
          >
            <Home className="h-3.5 w-3.5" />
            Home
          </button>
          <button
            onClick={() => sendKeyEvent(187, "Recent")}
            disabled={!serial}
            className="ui-btn-secondary !px-2.5 !py-1"
          >
            <LayoutGrid className="h-3.5 w-3.5" />
            Recent
          </button>
          <button
            onClick={() => sendKeyEvent(25, "Vol-")}
            disabled={!serial}
            className="ui-btn-secondary !px-2.5 !py-1"
          >
            <Volume1 className="h-3.5 w-3.5" />
            Vol-
          </button>
          <button
            onClick={() => sendKeyEvent(24, "Vol+")}
            disabled={!serial}
            className="ui-btn-secondary !px-2.5 !py-1"
          >
            <Volume2 className="h-3.5 w-3.5" />
            Vol+
          </button>
          <button
            onClick={() => sendKeyEvent(26, "Power")}
            disabled={!serial}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-600 transition hover:bg-rose-500/20 disabled:pointer-events-none disabled:opacity-45 dark:text-rose-400"
          >
            <Power className="h-3.5 w-3.5" />
            Power
          </button>
        </div>

        <span className="text-[11px] text-slate-500 dark:text-slate-400">
          {isEn
            ? "Click to tap · Drag to swipe"
            : "点击屏幕发送 Tap · 按住拖拽发送 Swipe 滑动"}
        </span>
      </div>

      {error && <div className="ui-alert-err">{error}</div>}

      {/* Screen Canvas */}
      <div className="ui-card flex min-h-[280px] flex-1 items-center justify-center overflow-auto bg-slate-100/80 p-4 dark:bg-slate-950">
        {!serial ? (
          <div className="flex flex-col items-center justify-center gap-2 text-center text-xs text-slate-500 dark:text-slate-400">
            <MonitorSmartphone className="h-8 w-8 text-slate-300 dark:text-slate-700" />
            <span>{isEn ? "Please connect an ADB device first." : "请先连接一台 ADB 设备。"}</span>
          </div>
        ) : imageSrc ? (
          <div className="relative inline-block overflow-hidden rounded-lg border border-slate-300 bg-black shadow-xl dark:border-slate-700">
            <img
              ref={imgRef}
              src={imageSrc}
              alt="ADB Screen"
              draggable={false}
              onPointerDown={handlePointerDown}
              onPointerUp={handlePointerUp}
              onLoad={() => {
                if (!resolution && imgRef.current?.naturalWidth) {
                  setResolution({
                    width: imgRef.current.naturalWidth,
                    height: imgRef.current.naturalHeight,
                  });
                }
              }}
              className="block h-auto max-h-[calc(100vh-260px)] w-auto max-w-full cursor-crosshair select-none object-contain"
            />
            {tapMarker && (
              <span
                className="pointer-events-none absolute -ml-3 -mt-3 h-6 w-6 animate-ping rounded-full border-2 border-blue-400 bg-blue-400/30"
                style={{ left: `${tapMarker.xPct}%`, top: `${tapMarker.yPct}%` }}
              />
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 text-center text-xs text-slate-500 dark:text-slate-400">
            <RefreshCw className={`h-6 w-6 text-slate-300 dark:text-slate-700 ${loading ? "animate-spin" : ""}`} />
            <span>
              {loading
                ? isEn
                  ? "Capturing screen..."
                  : "正在抓取设备屏幕..."
                : isEn
                ? "No screen frame yet. Click Refresh."
                : "暂无画面，请点击刷新画面。"}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
