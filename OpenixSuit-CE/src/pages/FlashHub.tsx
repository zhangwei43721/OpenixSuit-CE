import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { FirmwareFlash } from "./FirmwareFlash";
import { SectorFlash } from "./SectorFlash";
import { GenericFlash } from "./GenericFlash";
import { FirmwareConverter } from "./FirmwareConverter";
import { FirmwareInspector } from "./FirmwareInspector";

export interface SharedPartitionEntry {
  index: number;
  name: string;
  download_file: string;
  start_sector: number;
  sectors: number;
  size_bytes: number;
  type_guid: string;
}

export interface SharedImageInspectResult {
  file_name: string;
  file_size: number;
  partition_size: number;
  file_count: number;
  encrypted: boolean;
  magic: string;
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

type FirmwareSubTab = "standard" | "sector" | "generic" | "converter" | "inspector";

export function FlashHub({
  isFlashing,
  onFlashingChange,
  onLog,
}: {
  isFlashing: boolean;
  onFlashingChange: (v: boolean) => void;
  onLog: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const [subTab, setSubTab] = useState<FirmwareSubTab>("standard");
  const [firmwarePath, setFirmwarePath] = useState("");
  const [inspectInfo, setInspectInfo] = useState<SharedImageInspectResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const pickSharedFirmware = async () => {
    try {
      const file = await open({ filters: [{ name: "Allwinner Image", extensions: ["img", "fex"] }] });
      if (typeof file !== "string") return;
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

  const tabs: { key: FirmwareSubTab; label: string }[] = [
    { key: "standard", label: t("nav.flashSubStandard") },
    { key: "sector", label: t("nav.flashSubSector") },
    { key: "generic", label: t("nav.flashSubGeneric") },
    { key: "converter", label: t("nav.converter") },
    { key: "inspector", label: t("nav.inspector") },
  ];

  return (
    <div className="flex h-full flex-col space-y-3">
      {/* 公共 .img 固件选择栏（标准刷机 / 扇区 MBR / 格式转换 / 解包查看共用） */}
      <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-slate-700 dark:text-slate-200">
              {t("flash.filePath")}: {firmwarePath || t("flash.unselected")}
            </div>
            {inspectInfo && (
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-slate-500 dark:text-slate-400">
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
          <button
            disabled={isFlashing}
            onClick={pickSharedFirmware}
            className="shrink-0 rounded bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {t("flash.selectFirmware")}
          </button>
        </div>
        {errorMsg && (
          <div className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-amber-600 dark:text-amber-400">
            {errorMsg}
          </div>
        )}
      </div>

      {/* 子功能分段选项卡 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 pb-2.5 dark:border-slate-800">
        {tabs.map((item) => (
          <button
            key={item.key}
            disabled={isFlashing}
            onClick={() => setSubTab(item.key)}
            className={`rounded-md px-3.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
              subTab === item.key
                ? "bg-blue-600 text-white"
                : "bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto">
        <div className={subTab === "standard" ? "h-full" : "hidden"}>
          <FirmwareFlash
            firmwarePath={firmwarePath}
            inspectInfo={inspectInfo}
            isFlashing={isFlashing}
            onFlashingChange={onFlashingChange}
            onLog={onLog}
          />
        </div>
        <div className={subTab === "sector" ? "h-full" : "hidden"}>
          <SectorFlash
            firmwarePath={firmwarePath}
            inspectInfo={inspectInfo}
            isFlashing={isFlashing}
            onFlashingChange={onFlashingChange}
            onLog={onLog}
          />
        </div>
        <div className={subTab === "generic" ? "h-full" : "hidden"}>
          <GenericFlash
            isFlashing={isFlashing}
            onFlashingChange={onFlashingChange}
            onLog={onLog}
          />
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
    </div>
  );
}
