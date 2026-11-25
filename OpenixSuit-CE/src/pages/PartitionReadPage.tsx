import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { efexDeviceLabel, type FelDevice } from "../components/TopBar";

interface PartitionTable {
  device_id: string;
  storage_type: number;
  reported_sectors: number;
  format: string;
  table_id: string;
  partitions: { id: number; name: string; start_sector: number; sectors: number }[];
}

interface ReadProgress {
  device_id: string;
  partition_id: number;
  name: string;
  read_bytes: number;
  total_bytes: number;
}

interface FileResult {
  partition_id: number;
  path: string;
  bytes: number;
  sha256: string;
}

function sizeText(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GiB`
    : `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
}

export function PartitionReadPage({ devices, deviceBusy, onBusyChange }: {
  devices: FelDevice[];
  deviceBusy: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const [selectedDevice, setSelectedDevice] = useState("");
  const [bootFirmware, setBootFirmware] = useState("");
  const [table, setTable] = useState<PartitionTable | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [operation, setOperation] = useState<"list" | "export" | null>(null);
  const [cancelPending, setCancelPending] = useState(false);
  const [progress, setProgress] = useState<ReadProgress | null>(null);
  const [files, setFiles] = useState<FileResult[]>([]);
  const [outputDirectory, setOutputDirectory] = useState("");
  const [error, setError] = useState("");
  const deviceId = selectedDevice || (devices.length === 1 ? devices[0].id : "");
  const device = devices.find((item) => item.id === deviceId);
  const needsLoader = Boolean(device?.mode.startsWith("FEL"));
  const current = table?.device_id === deviceId ? table : null;
  const listBlock = !device ? (devices.length ? "partitionRead.pickDevice" : "flash.noTargetHint")
    : needsLoader && !bootFirmware ? "partitionRead.loaderHint" : null;
  const exportBlock = listBlock || (!current ? "partitionRead.readTableHint"
    : !selected.length ? "flash.pickPartitionsHint" : null);

  useEffect(() => {
    if (operation !== "export") return;
    const unlisten = listen<ReadProgress>("partition-read-progress", ({ payload }) => {
      if (payload.device_id === deviceId) setProgress(payload);
    });
    return () => { void unlisten.then((stop) => stop()).catch(() => {}); };
  }, [deviceId, operation]);

  function clearTable() {
    setTable(null);
    setSelected([]);
    setProgress(null);
    setFiles([]);
    setOutputDirectory("");
    setError("");
  }

  async function chooseBootFirmware() {
    try {
      const file = await open({ filters: [{ name: "IMAGEWTY", extensions: ["img"] }] });
      if (typeof file === "string" && file !== bootFirmware) {
        clearTable();
        setBootFirmware(file);
      }
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function run(action: "list" | "export") {
    if (deviceBusy || listBlock) return;
    if (action === "export" && exportBlock) return;
    // 锁定实际选中的设备，让它在 FEL 到 FES 的重连过程中保持选中。
    setSelectedDevice(deviceId);
    setOperation(action);
    onBusyChange(true);
    setCancelPending(false);
    setError("");
    setProgress(null);
    setFiles([]);
    setOutputDirectory("");
    const target = { device_id: deviceId, boot_firmware: bootFirmware || null };
    try {
      if (action === "list") {
        clearTable();
        setTable(await invoke<PartitionTable>("list_device_partitions", { target }));
      } else if (current) {
        const outDir = await open({ directory: true });
        if (typeof outDir !== "string") return;
        const result = await invoke<{error: string | null; files: FileResult[]}>("export_device_partitions", {
          request: { ...target, table_id: current.table_id, partition_ids: selected, out_dir: outDir },
        });
        setFiles(result.files);
        if (result.files.length) setOutputDirectory(outDir);
        setError(result.error ?? "");
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      onBusyChange(false);
      setOperation(null);
      setProgress(null);
      setCancelPending(false);
    }
  }

  async function cancel() {
    try {
      setCancelPending(await invoke<boolean>("cancel_partition_read"));
    } catch (reason) {
      setError(String(reason));
    }
  }

  return (
    <div className="space-y-3 text-xs">
      <section className="ui-card p-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-44 flex-1 space-y-1">
            <span className="block">{t("partitionRead.device")}</span>
            <select
              className="ui-select w-full"
              disabled={deviceBusy}
              value={deviceId}
              onChange={(event) => { setSelectedDevice(event.target.value); clearTable(); }}
            >
              <option value="">{t("partitionRead.pickDevice")}</option>
              {deviceId && !device && <option value={deviceId} disabled>{deviceId} · {t("partitionRead.disconnected")}</option>}
              {devices.map((item) => (
                <option key={item.id} value={item.id}>{efexDeviceLabel(item)}</option>
              ))}
            </select>
          </label>
          <button type="button" className="ui-btn-secondary" disabled={deviceBusy || Boolean(listBlock)} onClick={() => void run("list")}>
            {t("partitionRead.readTable")}
          </button>
        </div>
        {needsLoader && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" className="ui-btn-secondary" disabled={deviceBusy} onClick={() => void chooseBootFirmware()}>
              {t("partitionRead.pickLoader")}
            </button>
            <span className="min-w-0 truncate text-slate-600 dark:text-slate-300" title={bootFirmware}>
              {bootFirmware || t("partitionRead.loaderHint")}
            </span>
          </div>
        )}
      </section>

      {!operation && exportBlock && !(needsLoader && !bootFirmware) && (
        <p className="px-1 text-slate-600 dark:text-slate-300">{t(exportBlock)}</p>
      )}

      {current && (
        <section className="ui-card overflow-hidden">
          <div className="ui-card-header">
            <span className="ui-title">{current.format === "gpt" ? "GPT" : t("partitionRead.sunxiMbr")} · {sizeText(current.reported_sectors * 512)}</span>
            <button type="button" className="ui-btn-primary" disabled={deviceBusy || Boolean(exportBlock)} onClick={() => void run("export")}>
              {t("partitionRead.export", { count: selected.length })}
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-left">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800">
                  <th className="px-3 py-2">{t("partitionRead.partition")}</th>
                  <th className="px-3 py-2">{t("partitionRead.startSector")}</th>
                  <th className="px-3 py-2">{t("partitionRead.size")}</th>
                </tr>
              </thead>
              <tbody>
                {current.partitions.map((part) => (
                  <tr key={part.id} className="border-b border-slate-100 last:border-b-0 dark:border-slate-800">
                    <td className="px-3 py-2">
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          className="accent-blue-600"
                          disabled={deviceBusy || !part.sectors}
                          checked={selected.includes(part.id)}
                          onChange={(event) => {
                            const checked = event.target.checked;
                            setSelected((values) => checked ? [...values, part.id] : values.filter((id) => id !== part.id));
                          }}
                        />
                        <span className="text-slate-500">#{part.id}</span>
                        <span>{part.name}</span>
                      </label>
                    </td>
                    <td className="px-3 py-2 tabular-nums">{part.start_sector.toLocaleString()}</td>
                    <td className="px-3 py-2 tabular-nums">{part.sectors ? sizeText(part.sectors * 512) : t("partitionRead.unknownSize")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {operation && (
        <section className="ui-card space-y-2 p-3" role="status">
          <div className="flex items-center justify-between gap-2">
            <span>
              {progress
                ? `${progress.name} · ${sizeText(progress.read_bytes)} / ${sizeText(progress.total_bytes)}`
                : t(operation === "list" ? "partitionRead.listing" : "partitionRead.preparing")}
            </span>
            <button type="button" disabled={cancelPending} className="ui-btn-secondary" onClick={() => void cancel()}>
              {t(cancelPending ? "partitionRead.cancelling" : "common.cancel")}
            </button>
          </div>
          {progress && <progress className="w-full" aria-label={progress.name} value={progress.read_bytes} max={progress.total_bytes} />}
        </section>
      )}
      {error && <p className="ui-alert-err break-all" role="alert">{error}</p>}
      {files.length > 0 && (
        <section className="ui-card space-y-2 p-3" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="ui-title">{t("partitionRead.savedFiles", { count: files.length })}</h3>
            {outputDirectory && <button type="button" className="ui-btn-secondary" onClick={() => {
              void invoke("open_partition_output_folder", { directory: outputDirectory }).catch((failure) => setError(String(failure)));
            }}>{t("partitionRead.openFolder")}</button>}
          </div>
          {files.map((file) => (
            <div key={file.partition_id} className="space-y-0.5 break-all">
              <p>{file.path} · {file.bytes.toLocaleString()} B</p>
              <p className="font-mono text-[11px] text-slate-600 dark:text-slate-400">SHA-256 · {file.sha256}</p>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
