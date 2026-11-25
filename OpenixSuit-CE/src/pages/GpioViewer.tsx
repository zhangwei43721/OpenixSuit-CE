import { type ReactNode, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Check,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Edit2,
  RefreshCw,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { efexDeviceLabel, type FelDevice } from "../components/TopBar";

interface RuntimeGpioPin {
  pin_name: string;
  gpio_id: number;
  function: string;
  mux: number;
  pull: string;
  drv: string;
  data: string;
  functions: string[];
}

interface RuntimeGpioPort {
  port_name: string;
  port_index: number;
  pins: RuntimeGpioPin[];
}

interface PioPinState {
  index: number;
  name: string;
  mux: number;
  data: number;
  drv: number;
  pull: number;
}

/** Normalized pin row shared by both ADB and FEL modes. */
interface PortPinRow {
  pin_name: string;
  gpio_id: number;
  function: string;
  mux: number;
  pull: string;
  drv: string;
  data: string;
}

interface PortGroup {
  port_index: number;
  port_name: string;
  pins: PortPinRow[];
}

const PORTS = ["PA", "PB", "PC", "PD", "PE", "PF", "PG"];

const FEL_PULL_LABELS = ["PULL DISABLE", "Pull Up", "Pull Down"];

const felFunctionLabel = (mux: number) =>
  mux === 0 ? "GPIO_IN" : mux === 1 ? "GPIO_OUT" : mux === 15 ? "IO_DISABLED" : `FUNC${mux}`;

const felToRow = (pin: PioPinState, portIdx: number): PortPinRow => ({
  pin_name: pin.name,
  gpio_id: portIdx * 32 + pin.index,
  function: felFunctionLabel(pin.mux),
  mux: pin.mux,
  pull: FEL_PULL_LABELS[pin.pull] ?? "PULL DISABLE",
  drv: `0x${pin.drv.toString(16)}`,
  data: pin.data === 1 ? "HIGH" : "LOW",
});

export function GpioViewer({
  serial,
  adbLabel,
  felDevices,
  onLog,
}: {
  serial: string;
  adbLabel: string;
  felDevices: FelDevice[];
  onLog: (msg: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [mode, setMode] = useState<"adb" | "fel">("adb");
  const [chipName, setChipName] = useState("-");
  const [adbPorts, setAdbPorts] = useState<PortGroup[]>([]);
  const [felPorts, setFelPorts] = useState<PortGroup[]>([]);
  const [felLoadingPorts, setFelLoadingPorts] = useState<Set<number>>(new Set());
  const [expandedPorts, setExpandedPorts] = useState<Set<number>>(new Set());
  const [editingPin, setEditingPin] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{ mux: number; pull: string; drv: string }>({
    mux: 0,
    pull: "PULL DISABLE",
    drv: "0x1",
  });

  const [baseAddr, setBaseAddr] = useState(() => localStorage.getItem("gpio_base_addr") || "0x02000000");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [felSelection, setFelSelection] = useState("");
  const [adbReadAt, setAdbReadAt] = useState<number | null>(null);
  const [felReadAt, setFelReadAt] = useState<number | null>(null);
  const [savingPin, setSavingPin] = useState(false);
  const [writeResult, setWriteResult] = useState<{ text: string; failed?: boolean } | null>(null);
  const felTargets = felDevices.filter((device) =>
    device.mode.startsWith("FEL (") &&
    felDevices.filter((candidate) => candidate.id === device.id).length === 1
  );
  const felTarget = felTargets.find((device) => device.id ===
    (felSelection || (felTargets.length === 1 ? felTargets[0].id : "")));
  const felId = felTarget?.id;
  const felSnapshot = `${felId ?? ""}:${felTarget?.usb_path ?? ""}:${baseAddr}`;
  const activeFelSnapshot = useRef(felSnapshot);
  activeFelSnapshot.current = felSnapshot;
  const readAt = mode === "adb" ? adbReadAt : felReadAt;
  const pioBase = /^(?:0x)?[0-9a-f]{1,8}$/i.test(baseAddr.trim()) ? Number.parseInt(baseAddr, 16) : null;
  const validPioBase = pioBase !== null && pioBase + PORTS.length * 0x24 <= 0x100000000;

  const loadRuntimeGpio = async (targetSerial = serial) => {
    if (!targetSerial) {
      setAdbPorts([]);
      setChipName("-");
      setAdbReadAt(null);
      return;
    }
    setLoading(true);
    setErrorMsg(null);
    try {
      const rep = await invoke<{ chip: string; ports?: RuntimeGpioPort[]; pins: RuntimeGpioPin[] }>(
        "adb_detect_gpio",
        { serial: targetSerial },
      );
      setChipName(rep.chip);
      const ports: PortGroup[] = (rep.ports ?? []).map((port) => ({
        port_index: port.port_index,
        port_name: port.port_name,
        pins: port.pins.map((pin) => ({
          pin_name: pin.pin_name,
          gpio_id: pin.gpio_id,
          function: pin.function,
          mux: pin.mux,
          pull: pin.pull,
          drv: pin.drv,
          data: pin.data,
        })),
      }));
      setAdbPorts(ports);
      setAdbReadAt(Date.now());
      setExpandedPorts((prev) => {
        if (prev.size > 0) return prev;
        return ports.length > 0 ? new Set([ports[0].port_index]) : new Set();
      });
      onLog(`GPIO (${rep.chip}): ${rep.pins.length} pins`);
      return rep.pins;
    } catch (err) {
      setAdbPorts([]);
      setAdbReadAt(null);
      setErrorMsg(String(err));
    } finally {
      setLoading(false);
    }
  };

  const loadFelPort = async (idx: number) => {
    if (!felId || !validPioBase || felLoadingPorts.size > 0) return;
    setFelLoadingPorts((prev) => new Set(prev).add(idx));
    setErrorMsg(null);
    try {
      const res = await invoke<PioPinState[]>("read_pio_port", {
        baseAddr: pioBase,
        portIndex: idx,
        portName: PORTS[idx],
        deviceId: felId,
      });
      if (activeFelSnapshot.current !== felSnapshot) return;
      setFelPorts((prev) => {
        const next = prev.filter((p) => p.port_index !== idx);
        next.push({ port_index: idx, port_name: PORTS[idx], pins: res.map((p) => felToRow(p, idx)) });
        next.sort((a, b) => a.port_index - b.port_index);
        return next;
      });
      setFelReadAt(Date.now());
    } catch (err) {
      if (activeFelSnapshot.current === felSnapshot) setErrorMsg(String(err));
    } finally {
      setFelLoadingPorts((prev) => {
        const next = new Set(prev);
        next.delete(idx);
        return next;
      });
    }
  };

  useEffect(() => {
    setErrorMsg(null);
    setEditingPin(null);
    setExpandedPorts(new Set());
    if (mode === "adb") {
      loadRuntimeGpio(serial);
    } else {
      setChipName("-");
    }
  }, [serial, mode]);

  useEffect(() => {
    setFelPorts([]);
    setFelReadAt(null);
    if (mode === "fel") setExpandedPorts(new Set());
  }, [felSnapshot]);

  const saveEditPin = async (pinName: string) => {
    if (!serial || savingPin || loading) return;
    setSavingPin(true);
    setWriteResult(null);
    try {
      await invoke("adb_set_gpio", {
        serial,
        pinName,
        mux: editDraft.mux,
        pull: editDraft.pull,
        drv: editDraft.drv,
      });
      onLog(`Updated ${pinName}`);
      setEditingPin(null);
      const pin = (await loadRuntimeGpio(serial))?.find((item) => item.pin_name === pinName);
      setWriteResult({
        text: pin ? t("gpio.writeReadback", { pin: pinName, function: pin.function, pull: pin.pull, drive: pin.drv })
          : t("gpio.writeNoReadback", { pin: pinName }),
        failed: !pin,
      });
    } catch (err) {
      setWriteResult({ text: t("gpio.writeFailed", { pin: pinName, error: String(err) }), failed: true });
    } finally {
      setSavingPin(false);
    }
  };

  const groups: PortGroup[] =
    mode === "adb"
      ? adbPorts
      : PORTS.map(
          (name, idx) =>
            felPorts.find((p) => p.port_index === idx) ?? { port_index: idx, port_name: name, pins: [] },
        );

  const togglePort = (idx: number) => {
    const willExpand = !expandedPorts.has(idx);
    setExpandedPorts((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
    if (
      willExpand &&
      mode === "fel" &&
      felId &&
      !felPorts.some((p) => p.port_index === idx)
    ) {
      void loadFelPort(idx);
    }
  };

  const allPortsExpanded =
    groups.length > 0 && groups.every((g) => expandedPorts.has(g.port_index));

  const toggleAllPorts = async () => {
    if (allPortsExpanded) {
      setExpandedPorts(new Set());
      return;
    }
    setExpandedPorts(new Set(groups.map((g) => g.port_index)));
    if (mode === "fel" && felId) {
      for (const g of groups) {
        if (activeFelSnapshot.current !== felSnapshot) break;
        if (!felPorts.some((p) => p.port_index === g.port_index)) {
          await loadFelPort(g.port_index);
        }
      }
    }
  };

  const refreshCurrent = async () => {
    if (mode === "adb") {
      void loadRuntimeGpio(serial);
    } else {
      for (const g of groups) {
        if (activeFelSnapshot.current !== felSnapshot) break;
        if (expandedPorts.has(g.port_index) || felPorts.some((p) => p.port_index === g.port_index)) {
          await loadFelPort(g.port_index);
        }
      }
    }
  };

  const canRefresh = mode === "adb" ? !!serial && !loading && !savingPin : !!felId && validPioBase && felLoadingPorts.size === 0;

  const renderPinRow = (pin: PortPinRow, editable: boolean) => {
    const isEditing = editable && editingPin === pin.pin_name;
    const isHigh = pin.data.toUpperCase() === "HIGH" || pin.data === "1";
    return (
      <tr key={pin.pin_name} className={isEditing ? "bg-blue-500/10" : "hover:bg-slate-50/80 dark:hover:bg-slate-800/50"}>
        <td className="px-3 py-2 font-mono font-semibold tabular-nums text-blue-600 dark:text-blue-400">
          {pin.pin_name}
        </td>
        <td className="px-3 py-2 font-mono tabular-nums text-slate-600 dark:text-slate-300">
          {pin.gpio_id}
        </td>
        <td className="px-3 py-2">
          {isEditing ? (
            <select
              value={editDraft.mux}
              onChange={(e) => setEditDraft({ ...editDraft, mux: Number(e.target.value) })}
              className="ui-select ui-select-compact"
            >
              <option value={0}>(0): GPIO_IN</option>
              <option value={1}>(1): GPIO_OUT</option>
              <option value={15}>(15): IO_DISABLED</option>
            </select>
          ) : (
            <span className="font-mono font-semibold text-slate-800 dark:text-slate-100">
              {pin.function}
            </span>
          )}
        </td>
        <td className="px-3 py-2 font-mono tabular-nums text-slate-600 dark:text-slate-300">
          {isEditing ? editDraft.mux : pin.mux}
        </td>
        <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
          {isEditing ? (
            <select
              value={editDraft.pull}
              onChange={(e) => setEditDraft({ ...editDraft, pull: e.target.value })}
              className="ui-select ui-select-compact"
            >
              <option value="PULL DISABLE">PULL DISABLE</option>
              <option value="Pull Up">Pull Up</option>
              <option value="Pull Down">Pull Down</option>
            </select>
          ) : (
            pin.pull
          )}
        </td>
        <td className="px-3 py-2 font-mono tabular-nums text-slate-600 dark:text-slate-300">
          {isEditing ? (
            <select
              value={editDraft.drv}
              onChange={(e) => setEditDraft({ ...editDraft, drv: e.target.value })}
              className="ui-select ui-select-compact"
            >
              <option value="0x0">0x0</option>
              <option value="0x1">0x1</option>
              <option value="0x2">0x2</option>
              <option value="0x3">0x3</option>
            </select>
          ) : (
            pin.drv
          )}
        </td>
        <td className="px-3 py-2">
          <span
            className={`inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-[11px] font-semibold tabular-nums ${
              isHigh
                ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                : "border-slate-200 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
            }`}
          >
            {pin.data}
          </span>
        </td>
        <td className="px-3 py-2 text-right">
          {isEditing ? (
            <div className="inline-flex items-center gap-1">
              <button
                onClick={() => saveEditPin(pin.pin_name)}
                disabled={savingPin || loading}
                aria-label={t("gpio.savePin")}
                className="inline-flex items-center justify-center rounded-md bg-emerald-500/20 p-1.5 text-emerald-600 transition hover:bg-emerald-500/30 dark:text-emerald-400"
              >
                <Check className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => setEditingPin(null)}
                disabled={savingPin}
                aria-label={t("gpio.cancelEdit")}
                className="inline-flex items-center justify-center rounded-md bg-rose-500/20 p-1.5 text-rose-500 transition hover:bg-rose-500/30"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : editable ? (
            <button
              disabled={savingPin || loading}
              aria-label={t("gpio.editPin", { pin: pin.pin_name })}
              onClick={() => {
                setEditingPin(pin.pin_name);
                setEditDraft({ mux: pin.mux, pull: pin.pull, drv: pin.drv });
              }}
              className="inline-flex items-center justify-center rounded-md border border-slate-200 bg-white p-1.5 text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
            >
              <Edit2 className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </td>
      </tr>
    );
  };

  const renderGroupRows = (): ReactNode[] => {
    const rows: ReactNode[] = [];
    for (const port of groups) {
      const expanded = expandedPorts.has(port.port_index);
      const unread = mode === "fel" && port.pins.length === 0;
      rows.push(
        <tr
          key={`port-${port.port_index}`}
          className="cursor-pointer select-none bg-slate-100/80 transition hover:bg-slate-200/70 dark:bg-slate-800/50 dark:hover:bg-slate-700/60"
          onClick={() => togglePort(port.port_index)}
        >
          <td colSpan={8} className="px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 font-mono font-semibold text-slate-800 dark:text-slate-100">
                <ChevronDown
                  className={`h-3.5 w-3.5 transition-transform ${expanded ? "" : "-rotate-90"}`}
                />
                {port.port_name}
              </span>
              <span className="rounded-md bg-white/80 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-slate-500 dark:bg-slate-900/80 dark:text-slate-400">
                {unread && felId ? t("gpio.tapToRead") : t("gpio.pinCount", { count: port.pins.length })}
              </span>
            </div>
          </td>
        </tr>,
      );
      if (expanded) {
        for (const pin of port.pins) {
          rows.push(renderPinRow(pin, mode === "adb"));
        }
      }
    }
    return rows;
  };

  const totalPins = groups.reduce((n, g) => n + g.pins.length, 0);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 text-xs">
      <div className="ui-toolbar">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={mode}
            disabled={savingPin}
            onChange={(e) => setMode(e.target.value as "adb" | "fel")}
            className="ui-select"
          >
            <option value="adb">{t("gpio.adbMode")}</option>
            <option value="fel">{t("gpio.felMode")}</option>
          </select>

          {mode === "adb" ? (
            <span className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 font-mono text-xs tabular-nums text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
              {t("gpio.chip", { chip: chipName })}
            </span>
          ) : (
            <label className="flex items-center gap-1.5">
              <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                {t("gpio.pioBase")}
              </span>
              <input
                value={baseAddr}
                disabled={felLoadingPorts.size > 0}
                aria-invalid={!validPioBase}
                onChange={(e) => {
                  setBaseAddr(e.target.value);
                  localStorage.setItem("gpio_base_addr", e.target.value);
                  setFelPorts([]);
                }}
                title={t("gpio.pioBase")}
                className="ui-input w-32 font-mono tabular-nums"
              />
            </label>
          )}
        </div>

        <div className="flex items-center gap-2">
          {groups.length > 0 && (
            <button onClick={() => void toggleAllPorts()} disabled={felLoadingPorts.size > 0} className="ui-btn-secondary">
              {allPortsExpanded ? (
                <ChevronsDownUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronsUpDown className="h-3.5 w-3.5" />
              )}
              {allPortsExpanded ? t("gpio.collapseAll") : t("gpio.expandAll")}
            </button>
          )}

          <button
            disabled={!canRefresh}
            onClick={refreshCurrent}
            className="ui-btn-primary"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading || felLoadingPorts.size > 0 ? "animate-spin" : ""}`} />
            {t("gpio.refreshData")}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-slate-500 dark:text-slate-400">
        {mode === "fel" && (felTargets.length > 0 || felSelection) ? (
          <label className="flex flex-wrap items-center gap-2">
            {t("gpio.device")}
            <select className="ui-select min-w-0 max-w-full" value={felTarget?.id ?? ""} disabled={felLoadingPorts.size > 0}
              onChange={(event) => setFelSelection(event.target.value)}>
              <option value="">{t("gpio.selectFel")}</option>
              {felTargets.map((device) => <option key={device.id} value={device.id}>{efexDeviceLabel(device)}</option>)}
            </select>
          </label>
        ) : <span>{t("gpio.target", { device: (mode === "adb" && adbLabel) || t("gpio.noDevice") })}</span>}
        <span>{t("gpio.lastRead", { time: readAt === null ? "—" : new Date(readAt).toLocaleTimeString(i18n.language) })}</span>
        {mode === "fel" && <span>{t("gpio.readOnly")}</span>}
      </div>
      {mode === "fel" && !felId && (
        <div className="ui-alert-warn">
          {t(felTargets.length > 0 ? "gpio.selectFel" : "gpio.noFel")}
        </div>
      )}
      {mode === "fel" && !validPioBase && <div className="ui-alert-warn">{t("gpio.invalidBase")}</div>}

      {errorMsg && <div className="ui-alert-err">{errorMsg}</div>}
      {mode === "adb" && writeResult && (
        <div role="status" className={writeResult.failed ? "ui-alert-err" : "ui-alert-ok"}>{writeResult.text}</div>
      )}

      <div className="ui-card flex-1 min-h-0 overflow-y-auto">
        <table className="w-full text-left">
          <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-50/95 text-[11px] font-semibold uppercase tracking-wider text-slate-500 backdrop-blur-sm dark:border-slate-800 dark:bg-slate-950/95 dark:text-slate-400">
            <tr>
              {["pin", "pinId", "function", "mux", "pull", "drive", "level"].map((column) =>
                <th key={column} className="px-3 py-2.5">{t(`gpio.columns.${column}`)}</th>
              )}
              <th className="px-3 py-2.5 text-right">{t("sector.actions")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
            {mode === "adb" && adbPorts.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-12 text-center text-slate-500 dark:text-slate-400">
                  {loading ? t("gpio.readingPins") : t("gpio.noPins")}
                </td>
              </tr>
            ) : (
              renderGroupRows()
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between px-1 font-mono text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
        <span>{t("gpio.pinCount", { count: totalPins })}</span>
      </div>
    </div>
  );
}
