import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { Cable, History, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { FirmwareFlash } from "./FirmwareFlash";
import { GenericFlash } from "./GenericFlash";
import { FirmwareConverter } from "./FirmwareConverter";
import { FirmwareInspector } from "./FirmwareInspector";
import { PartitionReadPage } from "./PartitionReadPage";
import {
  FlashHistoryItem,
  SerialDataPayload,
  SerialPortInfo,
} from "../types/workbench";
import type { FelDevice } from "../components/TopBar";
import { AnsiText } from "../utils/ansi";

export interface SharedPartitionEntry {
  index: number;
  name: string;
  download_file: string;
  start_sector: number;
  sectors: number;
  size_bytes: number;
  type_guid: string;
  sparse?: boolean;
}

export interface SharedImageInspectResult {
  file_name: string;
  file_size: number;
  partition_size: number;
  file_count: number;
  encrypted: boolean;
  magic: string;
  header_version?: string;
  sys_config_raw?: string;
  sys_config: {
    debug_print: string;
    storage_type: string;
    i2c_port: string;
    i2c_scl: string;
    i2c_sda: string;
    uart_port: string;
    uart_baud: string;
    uart_tx: string;
    uart_rx: string;
  };
  boot0: { magic: string; platform: string; dram_size_mb: number } | null;
  partitions: SharedPartitionEntry[];
  files: SharedPartitionEntry[];
}

type FirmwareSubTab = "standard" | "generic" | "partition-read" | "converter" | "inspector";

export function FlashHub({
  felDevices,
  isFlashing,
  onFlashingChange,
  onLog,
}: {
  felDevices: FelDevice[];
  isFlashing: boolean;
  onFlashingChange: (v: boolean) => void;
  onLog: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const [subTab, setSubTab] = useState<FirmwareSubTab>("standard");
  const [firmwarePath, setFirmwarePath] = useState("");
  const [inspectInfo, setInspectInfo] = useState<SharedImageInspectResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyList, setHistoryList] = useState<FlashHistoryItem[]>([]);
  const [showSerialSide, setShowSerialSide] = useState(false);
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [monPort, setMonPort] = useState("");
  const [monBaud, setMonBaud] = useState(115200);
  const [monConnected, setMonConnected] = useState(false);
  const [monText, setMonText] = useState("");

  const MON_SESSION_ID = "flash-side-monitor";

  const refreshHistory = useCallback(() => {
    invoke<FlashHistoryItem[]>("flash_history_list")
      .then((res) => setHistoryList(Array.isArray(res) ? res : []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  useEffect(() => {
    if (!showSerialSide) return;
    invoke<SerialPortInfo[]>("serial_list_ports")
      .then((res) => {
        const list = Array.isArray(res) ? res : [];
        setPorts(list);
        if (!monPort && list.length > 0) setMonPort(list[0].port_name);
      })
      .catch(() => {});
  }, [showSerialSide, monPort]);

  useEffect(() => {
    const unlisten = listen<SerialDataPayload>("serial-data", (e) => {
      if (e.payload.session_id === MON_SESSION_ID) {
        setMonText((prev) => {
          const next = prev + e.payload.chunk;
          return next.length > 60000 ? next.slice(-60000) : next;
        });
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const toggleSideMonitor = async () => {
    if (monConnected) {
      await invoke("serial_close", { sessionId: MON_SESSION_ID }).catch(() => {});
      setMonConnected(false);
      return;
    }
    if (!monPort) return;
    try {
      await invoke("serial_open", {
        sessionId: MON_SESSION_ID,
        portName: monPort,
        baudRate: monBaud,
      });
      setMonConnected(true);
    } catch (err) {
      onLog(`打开烧录串口监视失败: ${String(err)}`);
    }
  };

  const loadFirmwareFile = async (file: string) => {
    try {
      setErrorMsg(null);
      setFirmwarePath(file);
      const info = await invoke<SharedImageInspectResult>("inspect_image", { path: file });
      setInspectInfo(info);
      onLog(`已加载公共固件: ${file} (${info.partitions.length} 个分区, ${info.file_count} 个文件)`);
    } catch (err) {
      setInspectInfo(null);
      const msg = `加载固件失败: ${String(err)}`;
      setErrorMsg(msg);
      onLog(msg);
    }
  };

  const pickSharedFirmware = async () => {
    try {
      const file = await open({ filters: [{ name: "Allwinner Image", extensions: ["img", "fex"] }] });
      if (typeof file === "string") {
        await loadFirmwareFile(file);
      }
    } catch (err) {
      onLog(String(err));
    }
  };

  const recordFlashHistory = async (status: "completed" | "error", mode: string, message: string) => {
    if (!firmwarePath) return;
    const fwName = firmwarePath.split(/[\\/]/).pop() || firmwarePath;
    await invoke("flash_history_add", {
      item: {
        id: `fh-${Date.now()}`,
        firmware_path: firmwarePath,
        firmware_name: fwName,
        mode,
        status,
        message,
        timestamp: Math.floor(Date.now() / 1000),
      },
    }).catch(() => {});
    refreshHistory();
  };

  const tabs: { key: FirmwareSubTab; label: string }[] = [
    { key: "standard", label: t("nav.flashSubStandard") },
    { key: "generic", label: t("nav.flashSubGeneric") },
    { key: "partition-read", label: t("partitionRead.title") },
    { key: "converter", label: t("nav.converter") },
    { key: "inspector", label: t("nav.inspector") },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* 公共 .img 固件选择栏（标准刷机 / 格式转换 / 解包查看共用） */}
      <div className={subTab === "partition-read" ? "hidden" : "ui-card p-4 text-xs"}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center gap-2 truncate">
              <span className="shrink-0 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                {t("flash.filePath")}
              </span>
              <span className="truncate font-mono font-medium text-slate-800 dark:text-slate-100">
                {firmwarePath || t("flash.unselected")}
              </span>
            </div>
            {inspectInfo && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
                <span>{(inspectInfo.file_size / 1024 / 1024).toFixed(2)} MB</span>
                <span>Storage: {inspectInfo.sys_config.storage_type}</span>
                <span>Debug: {inspectInfo.sys_config.debug_print}</span>
                <span>
                  UART{inspectInfo.sys_config.uart_port}: {inspectInfo.sys_config.uart_tx}|
                  {inspectInfo.sys_config.uart_rx} @ {inspectInfo.sys_config.uart_baud}
                </span>
                <span>
                  TWI{inspectInfo.sys_config.i2c_port}: {inspectInfo.sys_config.i2c_scl}|
                  {inspectInfo.sys_config.i2c_sda}
                </span>
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setHistoryOpen((v) => !v)}
              className="ui-btn-secondary"
            >
              <History className="h-3.5 w-3.5" />
              {t("flash.history")} ({historyList.length})
            </button>
            <button
              disabled={isFlashing}
              onClick={pickSharedFirmware}
              className="ui-btn-primary"
            >
              {t("flash.selectFirmware")}
            </button>
          </div>
        </div>
        {historyOpen && (
          <div className="ui-subcard mt-3 space-y-2 p-3">
            <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
              <span className="font-medium">{t("flash.history")}</span>
              {historyList.length > 0 && (
                <button
                  onClick={async () => {
                    await invoke("flash_history_clear").catch(() => {});
                    refreshHistory();
                  }}
                  className="font-medium text-rose-500 transition hover:text-rose-600 dark:hover:text-rose-400"
                >
                  {t("log.clear")}
                </button>
              )}
            </div>
            {historyList.length === 0 ? (
              <div className="py-3 text-center text-[11px] text-slate-400">暂无烧录历史</div>
            ) : (
              <div className="max-h-32 space-y-1 overflow-y-auto">
                {historyList.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between gap-2 rounded-lg px-2 py-1 transition hover:bg-slate-200/70 dark:hover:bg-slate-900"
                  >
                    <button
                      onClick={() => {
                        setHistoryOpen(false);
                        loadFirmwareFile(item.firmware_path);
                      }}
                      className="min-w-0 flex-1 truncate text-left font-mono"
                    >
                      <span
                        className={`mr-1.5 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${
                          item.status === "completed"
                            ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                            : "bg-rose-500/15 text-rose-500"
                        }`}
                      >
                        {item.status}
                      </span>
                      {item.firmware_name}
                    </button>
                    <button
                      onClick={async () => {
                        await invoke("flash_history_delete", { id: item.id }).catch(() => {});
                        refreshHistory();
                      }}
                      className="rounded p-1 text-slate-400 transition hover:bg-rose-500/10 hover:text-rose-500"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {errorMsg && <div className="ui-alert-warn mt-3">{errorMsg}</div>}
      </div>

      {/* 子功能分段选项卡 */}
      <div className="ui-toolbar">
        <div className="ui-segmented flex-wrap">
          {tabs.map((item) => (
            <button
              key={item.key}
              disabled={isFlashing}
              onClick={() => setSubTab(item.key)}
              className={`ui-segmented-btn disabled:opacity-50 ${
                subTab === item.key
                  ? "bg-blue-600 text-white shadow-sm"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setShowSerialSide((v) => !v)}
          className={`ui-btn-secondary ${
            showSerialSide
              ? "border-blue-500 bg-blue-600/10 text-blue-600 hover:bg-blue-600/15 dark:border-blue-500 dark:bg-blue-600/15 dark:text-blue-400"
              : ""
          }`}
        >
          <Cable className="h-3.5 w-3.5" />
          {t("flash.serialMonitor")}
        </button>
      </div>

      <div className={`min-h-0 flex-1 ${showSerialSide ? "grid grid-cols-12 gap-3" : "flex flex-col"}`}>
        <div className={showSerialSide ? "col-span-7 h-full overflow-auto" : "h-full flex-1 overflow-auto"}>
          <div className={subTab === "standard" ? "h-full" : "hidden"}>
            <FirmwareFlash
              active={subTab === "standard"}
              firmwarePath={firmwarePath}
              felDevices={felDevices}
              inspectInfo={inspectInfo}
              isFlashing={isFlashing}
              onFlashingChange={onFlashingChange}
              onFlashComplete={recordFlashHistory}
              onLog={onLog}
            />
          </div>
          <div className={subTab === "generic" ? "h-full" : "hidden"}>
            <GenericFlash
              active={subTab === "generic"}
              isFlashing={isFlashing}
              felDevices={felDevices}
              onFlashingChange={onFlashingChange}
              onLog={onLog}
            />
          </div>
          <div className={subTab === "partition-read" ? "h-full" : "hidden"}>
            <PartitionReadPage devices={felDevices} deviceBusy={isFlashing} onBusyChange={onFlashingChange} />
          </div>
          <div className={subTab === "converter" ? "h-full" : "hidden"}>
            <FirmwareConverter
              firmwarePath={firmwarePath}
              inspectInfo={inspectInfo}
              onLog={onLog}
            />
          </div>
          <div className={subTab === "inspector" ? "h-full" : "hidden"}>
            <FirmwareInspector
              firmwarePath={firmwarePath}
              inspectInfo={inspectInfo}
              onLog={onLog}
            />
          </div>
        </div>

        {showSerialSide && (
          <div className="ui-card col-span-5 flex min-h-0 flex-col overflow-hidden text-xs">
            <div className="ui-card-header">
              <span className="ui-title text-blue-600 dark:text-blue-400">{t("flash.serialMonitor")}</span>
              <div className="flex flex-wrap items-center gap-1.5">
                <select
                  disabled={monConnected}
                  value={monPort}
                  onChange={(e) => setMonPort(e.target.value)}
                  className="ui-select max-w-[110px]"
                >
                  <option value="">串口...</option>
                  {ports.map((p) => (
                    <option key={p.port_name} value={p.port_name}>
                      {p.port_name}
                    </option>
                  ))}
                </select>
                <select
                  disabled={monConnected}
                  value={monBaud}
                  onChange={(e) => setMonBaud(Number(e.target.value))}
                  className="ui-select font-mono tabular-nums"
                >
                  {[115200, 921600, 1500000].map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
                <button
                  onClick={toggleSideMonitor}
                  className={monConnected ? "ui-btn-danger" : "ui-btn-success"}
                >
                  {monConnected ? "断开" : "连接"}
                </button>
                <button
                  onClick={() => setMonText("")}
                  className="ui-btn-secondary"
                >
                  清空
                </button>
              </div>
            </div>
            <div className="ui-terminal min-h-0 flex-1 overflow-auto rounded-none border-0 p-3 text-[11px]">
              {monText ? (
                <AnsiText text={monText} levelFormat="serial" />
              ) : (
                <span className="text-slate-500">选择串口点击连接，烧录时在此同步查看板子输出...</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
