import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";

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
  isFlashing,
  onFlashingChange,
  onLog,
}: {
  isFlashing: boolean;
  onFlashingChange: (v: boolean) => void;
  onLog: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const [bootImage, setBootImage] = useState("");
  const [genericImage, setGenericImage] = useState("");
  const [mode, setMode] = useState<"logic-offset" | "command">("logic-offset");
  const [storageType, setStorageType] = useState<"sdmmc" | "nor" | "ufs">("sdmmc");
  const [logicOffset, setLogicOffset] = useState(40960);
  const [diskInfo, setDiskInfo] = useState<GenericImageInfo | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  const pushLog = (msg: string) => {
    setLogs((p) => [...p.slice(-99), `[${new Date().toLocaleTimeString()}] ${msg}`]);
    onLog(msg);
  };

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
      const info = await invoke<GenericImageInfo>("read_partition_table", { diskImagePath: file });
      setDiskInfo(info);
      pushLog(`Parsed ${info.image_type}: ${info.partitions.length} partitions`);
    } catch (err) {
      pushLog(String(err));
    }
  };

  const changeStorage = (val: "sdmmc" | "nor" | "ufs") => {
    setStorageType(val);
    setLogicOffset(val === "nor" ? 2106 : 40960);
  };

  const startFlash = async () => {
    if (!genericImage) return;
    onFlashingChange(true);
    pushLog(`Raw flash: ${mode}, ${storageType}, offset=${logicOffset}`);
    try {
      await invoke("fes_download_partition", {
        partition: "raw",
        filePath: genericImage,
        verify: false,
      });
      pushLog("Raw flash completed");
    } catch (err) {
      pushLog(String(err));
    } finally {
      onFlashingChange(false);
    }
  };

  return (
    <div className="grid h-full grid-cols-12 gap-4">
      <div className="col-span-4 space-y-3 text-xs">
        <div className="space-y-2 rounded border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900">
          <div className="font-semibold text-slate-500">{t("generic.bootImage")}</div>
          <div className="flex gap-2">
            <input
              readOnly
              value={bootImage}
              placeholder={t("flash.unselected")}
              className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-950"
            />
            <button onClick={pickBoot} className="rounded bg-blue-600 px-3 py-1 text-white">
              {t("common.browse")}
            </button>
          </div>
        </div>

        <div className="space-y-2 rounded border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900">
          <div className="font-semibold text-slate-500">{t("generic.genericImage")}</div>
          <div className="flex gap-2">
            <input
              readOnly
              value={genericImage}
              placeholder={t("flash.unselected")}
              className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-950"
            />
            <button onClick={pickGeneric} className="rounded bg-blue-600 px-3 py-1 text-white">
              {t("common.browse")}
            </button>
          </div>
        </div>

        <div className="space-y-2 rounded border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900">
          <div className="font-semibold text-slate-500">{t("generic.modeAndOffset")}</div>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as "logic-offset" | "command")}
            className="w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-800"
          >
            <option value="logic-offset">{t("generic.modeLogic")}</option>
            <option value="command">{t("generic.modeCmd")}</option>
          </select>
          <select
            value={storageType}
            onChange={(e) => changeStorage(e.target.value as "sdmmc" | "nor" | "ufs")}
            className="w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-800"
          >
            <option value="sdmmc">SD/MMC</option>
            <option value="ufs">UFS</option>
            <option value="nor">SPI NOR</option>
          </select>
          <input
            type="number"
            value={logicOffset}
            onChange={(e) => setLogicOffset(Number(e.target.value))}
            className="w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-950"
          />
        </div>

        <button
          disabled={isFlashing || !genericImage}
          onClick={startFlash}
          className="w-full rounded bg-emerald-600 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {isFlashing ? t("flash.flashing") : t("generic.startFlash")}
        </button>
      </div>

      <div className="col-span-8 flex flex-col space-y-3">
        <div className="flex-1 rounded border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="mb-3 text-xs font-semibold text-blue-500">{t("generic.infoTitle")}</div>
          {diskInfo ? (
            <div className="space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-2">
                <div>Image Size: {(diskInfo.image_size / 1024 / 1024).toFixed(2)} MB</div>
                <div>Sectors: {diskInfo.sectors}</div>
                <div>Image Type: {diskInfo.image_type}</div>
                <div>Partition Count: {diskInfo.partitions.length}</div>
                <div className="col-span-2 font-mono">Disk GUID: {diskInfo.disk_guid}</div>
              </div>
              <table className="w-full text-left">
                <thead className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                  <tr>
                    <th className="py-1">Partition Name</th>
                    <th className="py-1">Start LBA</th>
                    <th className="py-1">Size</th>
                    <th className="py-1">Type GUID</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {diskInfo.partitions.map((p) => (
                    <tr key={`${p.index}-${p.name}`}>
                      <td className="py-1 font-medium">{p.name}</td>
                      <td className="py-1 font-mono">{p.start_sector}</td>
                      <td className="py-1 font-mono">{(p.size_bytes / 1024 / 1024).toFixed(2)} MB</td>
                      <td className="py-1 font-mono text-slate-500">{p.type_guid}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="py-12 text-center text-sm text-slate-500">{t("generic.emptyHint")}</div>
          )}
        </div>

        <pre className="h-28 overflow-y-auto rounded border border-slate-200 bg-slate-900 p-2.5 font-mono text-xs text-slate-300 dark:border-slate-800 dark:bg-slate-950">
          {logs.join("\n") || "LOG"}
        </pre>
      </div>
    </div>
  );
}
