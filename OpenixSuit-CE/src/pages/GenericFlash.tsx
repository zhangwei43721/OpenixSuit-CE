import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { LogMarkedText } from "../utils/ansi";
import { efexDeviceLabel, type FelDevice } from "../components/TopBar";

interface PartitionEntry {
  index: number;
  name: string;
  start_sector: number;
  sectors: number;
  size_bytes: number;
  type_guid: string;
}

interface GenericImageInfo {
  image_size: number;
  sectors: number;
  image_type: string;
  disk_guid: string;
  partitions: PartitionEntry[];
}

export function GenericFlash({
  active = true,
  isFlashing,
  felDevices,
  onFlashingChange,
  onLog,
}: {
  active?: boolean;
  isFlashing: boolean;
  felDevices: FelDevice[];
  onFlashingChange: (v: boolean) => void;
  onLog: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const [bootImage, setBootImage] = useState("");
  const [genericImage, setGenericImage] = useState("");
  const [mode, setMode] = useState<"logic-offset" | "command">("logic-offset");
  const [storageType, setStorageType] = useState<"sdmmc" | "nor" | "ufs">("sdmmc");
  const [logicOffset, setLogicOffset] = useState("40960");
  const [selectedTarget, setSelectedTarget] = useState("");
  const targetId = selectedTarget || (felDevices.length === 1 ? felDevices[0].id : "");
  const targets = felDevices.filter((device) => device.id === targetId);
  const target = targets.length === 1 ? targets[0] : undefined;
  const targetPair = /^bus:(\d+)-port:(\d+)$/.exec(targetId);
  const offset = Number(logicOffset);
  const validOffset = /^\d+$/.test(logicOffset.trim()) && Number.isInteger(offset) && offset <= 0x100000000;
  const flashBlock = !bootImage ? "generic.pickBootHint" : !genericImage ? "generic.pickDiskHint"
    : !target || !targetPair ? "flash.pickTargetHint"
    : mode === "logic-offset" && !validOffset ? "generic.invalidOffset" : null;
  const [diskInfo, setDiskInfo] = useState<GenericImageInfo | null>(null);
  const [progress, setProgress] = useState<{ partition: string; percent: number } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const logBoxRef = useRef<HTMLPreElement | null>(null);

  const appendLine = (msg: string) => {
    setLogs((p) => [...p.slice(-499), `[${new Date().toLocaleTimeString()}] ${msg}`]);
  };

  const pushLog = (msg: string) => {
    appendLine(msg);
    onLog(msg);
  };

  useEffect(() => {
    const unlistenProgress = listen<{ partition: string; percent: number }>("flash-progress", (e) => {
      setProgress({ partition: e.payload.partition, percent: e.payload.percent });
    });
    const unlistenLog = listen<{ stage: string; level: string; message: string }>(
      "flash-log",
      (e) => {
        if (!active || !e.payload?.message) return;
        const warnTag = e.payload.level === "warn" ? "[WARN] " : "";
        appendLine(`[${e.payload.stage || "FLASH"}] ${warnTag}${e.payload.message}`);
      }
    );
    return () => {
      unlistenProgress.then((fn) => fn());
      unlistenLog.then((fn) => fn());
    };
  }, [active]);

  useEffect(() => {
    if (logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [logs]);

  const pickBoot = async () => {
    try {
      const file = await open({ filters: [{ name: "Allwinner Boot Image", extensions: ["img"] }] });
      if (typeof file === "string") {
        setBootImage(file);
        pushLog(`Boot image: ${file}`);
      }
    } catch (err) {
      pushLog(String(err));
    }
  };

  const pickGeneric = async () => {
    try {
      const file = await open({ filters: [{ name: "Raw Disk Image", extensions: ["img", "bin", "raw"] }] });
      if (typeof file !== "string") return;
      setGenericImage(file);
      setDiskInfo(null);
      const info = await invoke<GenericImageInfo>("read_partition_table", { diskImagePath: file });
      setDiskInfo(info);
      pushLog(`Parsed ${info.image_type}: ${info.partitions.length} partitions`);
    } catch (err) {
      pushLog(String(err));
    }
  };

  const changeStorage = (val: "sdmmc" | "nor" | "ufs") => {
    setStorageType(val);
    setLogicOffset(val === "nor" ? "2106" : "40960");
  };

  const startFlash = async () => {
    if (isFlashing || flashBlock || !targetPair || !target) return;
    onFlashingChange(true);
    try {
      const confirmed = await ask(t("generic.confirmDetails", {
        target: efexDeviceLabel(target),
        storage: storageType.toUpperCase(),
        mode: t(mode === "logic-offset" ? "generic.modeLogic" : "generic.modeCmd"),
        offset: mode === "logic-offset" ? t("generic.offsetValue", { offset }) : t("generic.offsetUnused"),
      }), { kind: "warning", title: t("generic.startFlash") });
      if (!confirmed) return;
      setErrorMsg(null);
      setProgress(null);
      pushLog(`Raw flash: ${mode}, ${storageType}, offset=${logicOffset}`);
      const res = await invoke<string | void>("raw_flash_image", {
        bootFirmware: bootImage,
        rawImage: genericImage,
        mode,
        storage: storageType,
        logicOffset: mode === "logic-offset" ? offset : null,
        bus: Number(targetPair[1]),
        port: Number(targetPair[2]),
      });
      if (typeof res === "string" && res) pushLog(res);
      pushLog("Raw flash completed");
    } catch (err) {
      const msg = String(err);
      setErrorMsg(msg);
      pushLog(msg);
    } finally {
      onFlashingChange(false);
    }
  };

  const cancelFlash = async () => {
    try {
      await invoke("cancel_flash");
    } catch (err) {
      pushLog(String(err));
    }
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-12 gap-3">
      <div className="col-span-4 space-y-3 text-xs">
        <div className="ui-card overflow-hidden">
          <div className="ui-card-header">
            <span className="ui-title text-blue-600 dark:text-blue-400">{t("generic.bootImage")}</span>
          </div>
          <div className="flex gap-2 p-4">
            <input
              readOnly
              value={bootImage}
              placeholder={t("flash.unselected")}
              className="ui-input min-w-0 flex-1 font-mono"
            />
            <button onClick={pickBoot} className="ui-btn-secondary shrink-0">
              {t("common.browse")}
            </button>
          </div>
        </div>

        <div className="ui-card overflow-hidden">
          <div className="ui-card-header">
            <span className="ui-title text-blue-600 dark:text-blue-400">{t("generic.genericImage")}</span>
          </div>
          <div className="flex gap-2 p-4">
            <input
              readOnly
              value={genericImage}
              placeholder={t("flash.unselected")}
              className="ui-input min-w-0 flex-1 font-mono"
            />
            <button onClick={pickGeneric} className="ui-btn-secondary shrink-0">
              {t("common.browse")}
            </button>
          </div>
        </div>

        <div className="ui-card overflow-hidden">
          <div className="ui-card-header">
            <span className="ui-title text-blue-600 dark:text-blue-400">{t("generic.modeAndOffset")}</span>
          </div>
          <div className="space-y-2.5 p-4">
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as "logic-offset" | "command")}
              className="ui-select w-full"
            >
              <option value="logic-offset">{t("generic.modeLogic")}</option>
              <option value="command">{t("generic.modeCmd")}</option>
            </select>
            <select
              value={storageType}
              onChange={(e) => changeStorage(e.target.value as "sdmmc" | "nor" | "ufs")}
              className="ui-select w-full"
            >
              <option value="sdmmc">SD/MMC</option>
              <option value="ufs">UFS</option>
              <option value="nor">SPI NOR</option>
            </select>
            <p className="text-xs text-slate-600 dark:text-slate-300">
              {t(mode === "logic-offset" ? "generic.modeLogicHint" : "generic.modeCmdHint")}
            </p>
            {mode === "logic-offset" && (
              <label className="block space-y-1 text-xs">
                <span>{t("generic.offsetLabel")}</span>
                <input type="number" min={0} max={4294967296} step={1} value={logicOffset}
                  aria-invalid={!validOffset}
                  onChange={(event) => setLogicOffset(event.target.value)}
                  className="ui-input w-full font-mono tabular-nums" />
              </label>
            )}
            <label className="block space-y-1 text-xs">
              <span>{t("flash.felTarget")}</span>
              <select className="ui-select w-full" value={targetId} disabled={isFlashing}
                onChange={(event) => setSelectedTarget(event.target.value)}>
                <option value="">{t("flash.selectDevice")}</option>
                {felDevices.map((device, index) => <option key={`${device.id}-${index}`} value={device.id}>{efexDeviceLabel(device)}</option>)}
              </select>
            </label>
          </div>
        </div>

        <div className="ui-card space-y-3 p-4">
          {progress && (
            <div className="space-y-1.5">
              <div className="flex justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                <span className="truncate">{progress.partition}</span>
                <span className="shrink-0 font-mono tabular-nums">{progress.percent.toFixed(1)}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                <div className="h-full rounded-full bg-emerald-600 transition-all" style={{ width: `${progress.percent}%` }} />
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <button
              disabled={isFlashing || Boolean(flashBlock)}
              onClick={startFlash}
              className="ui-btn-success flex-1 py-2"
            >
              {isFlashing ? t("flash.flashing") : t("generic.startFlash")}
            </button>
            {isFlashing && (
              <button
                onClick={cancelFlash}
                className="ui-btn-danger py-2"
              >
                {t("common.cancel")}
              </button>
            )}
          </div>
        </div>

        {!isFlashing && flashBlock && <p className="text-xs text-slate-600 dark:text-slate-300">{t(flashBlock)}</p>}
        {errorMsg && <div className="ui-alert-warn">{errorMsg}</div>}
      </div>

      <div className="col-span-8 flex min-h-0 flex-col gap-3">
        <div className="ui-card flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="ui-card-header">
            <span className="ui-title text-blue-600 dark:text-blue-400">{t("generic.infoTitle")}</span>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {diskInfo ? (
              <div className="space-y-4 text-xs">
                <div className="grid grid-cols-2 gap-2.5">
                  <div className="ui-subcard flex items-center justify-between px-3 py-2">
                    <span className="text-slate-500 dark:text-slate-400">Image Size</span>
                    <span className="font-mono font-medium tabular-nums text-slate-800 dark:text-slate-100">
                      {(diskInfo.image_size / 1024 / 1024).toFixed(2)} MB
                    </span>
                  </div>
                  <div className="ui-subcard flex items-center justify-between px-3 py-2">
                    <span className="text-slate-500 dark:text-slate-400">Sectors</span>
                    <span className="font-mono font-medium tabular-nums text-slate-800 dark:text-slate-100">
                      {diskInfo.sectors}
                    </span>
                  </div>
                  <div className="ui-subcard flex items-center justify-between px-3 py-2">
                    <span className="text-slate-500 dark:text-slate-400">Image Type</span>
                    <span className="font-mono font-medium text-slate-800 dark:text-slate-100">
                      {diskInfo.image_type}
                    </span>
                  </div>
                  <div className="ui-subcard flex items-center justify-between px-3 py-2">
                    <span className="text-slate-500 dark:text-slate-400">Partition Count</span>
                    <span className="font-mono font-medium tabular-nums text-slate-800 dark:text-slate-100">
                      {diskInfo.partitions.length}
                    </span>
                  </div>
                  <div className="ui-subcard col-span-2 flex items-center justify-between gap-2 px-3 py-2">
                    <span className="shrink-0 text-slate-500 dark:text-slate-400">Disk GUID</span>
                    <span className="truncate font-mono text-slate-800 dark:text-slate-100">{diskInfo.disk_guid}</span>
                  </div>
                </div>
                <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
                  <table className="w-full text-left">
                    <thead className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold text-slate-500 dark:border-slate-800 dark:bg-slate-950/60 dark:text-slate-400">
                      <tr>
                        <th className="px-3 py-2">Partition Name</th>
                        <th className="px-3 py-2">Start LBA</th>
                        <th className="px-3 py-2">Size</th>
                        <th className="px-3 py-2">Type GUID</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                      {diskInfo.partitions.map((p) => (
                        <tr key={`${p.index}-${p.name}`} className="transition hover:bg-slate-50/80 dark:hover:bg-slate-800/40">
                          <td className="px-3 py-2 font-medium text-slate-800 dark:text-slate-100">{p.name}</td>
                          <td className="px-3 py-2 font-mono tabular-nums">{p.start_sector}</td>
                          <td className="px-3 py-2 font-mono tabular-nums">{(p.size_bytes / 1024 / 1024).toFixed(2)} MB</td>
                          <td className="px-3 py-2 font-mono text-slate-500 dark:text-slate-400">{p.type_guid}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="flex h-full min-h-[140px] items-center justify-center rounded-lg border border-dashed border-slate-200 p-6 text-center text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                {t("generic.emptyHint")}
              </div>
            )}
          </div>
        </div>

        <div className="ui-card flex h-48 shrink-0 flex-col overflow-hidden">
          <div className="ui-card-header py-2">
            <span className="ui-title">
              {t("log.live")} ({logs.length})
            </span>
            {logs.length > 0 && (
              <button
                type="button"
                onClick={() => setLogs([])}
                className="text-[11px] font-medium text-slate-500 transition hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
              >
                {t("log.clear")}
              </button>
            )}
          </div>
          <pre
            ref={logBoxRef}
            className="ui-terminal min-h-0 flex-1 overflow-y-auto rounded-none border-0 p-3 text-slate-300"
          >
            {logs.length > 0 ? <LogMarkedText text={logs.join("\n")} /> : "LOG"}
          </pre>
        </div>
      </div>
    </div>
  );
}
