import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Edit2, RefreshCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";

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

interface PioPinState {
  index: number;
  name: string;
  mux: number;
  data: number;
  drv: number;
  pull: number;
}

const PORTS = ["PA", "PB", "PC", "PD", "PE", "PF", "PG"];

export function GpioViewer({
  serial,
  felConnected,
  onLog,
}: {
  serial: string;
  felConnected: boolean;
  onLog: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"adb" | "fel">("adb");
  const [chipName, setChipName] = useState("-");
  const [runtimePins, setRuntimePins] = useState<RuntimeGpioPin[]>([]);
  const [editingPin, setEditingPin] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{ mux: number; pull: string; drv: string }>({
    mux: 0,
    pull: "PULL DISABLE",
    drv: "0x1",
  });

  const [baseAddr, setBaseAddr] = useState(() => localStorage.getItem("gpio_base_addr") || "0x02000000");
  const [portIndex, setPortIndex] = useState(0);
  const [felPins, setFelPins] = useState<PioPinState[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const reqIdRef = useRef(0);

  const loadRuntimeGpio = async (targetSerial = serial) => {
    if (!targetSerial) {
      setRuntimePins([]);
      setChipName("-");
      return;
    }
    setLoading(true);
    setErrorMsg(null);
    try {
      const rep = await invoke<{ chip: string; pins: RuntimeGpioPin[] }>("adb_detect_gpio", {
        serial: targetSerial,
      });
      setChipName(rep.chip);
      setRuntimePins(rep.pins);
      onLog(`GPIO (${rep.chip}): ${rep.pins.length} pins`);
    } catch (err) {
      setRuntimePins([]);
      setErrorMsg(String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setErrorMsg(null);
    if (mode === "adb") {
      loadRuntimeGpio(serial);
    } else if (felConnected) {
      loadFelPort(portIndex);
    } else {
      setFelPins([]);
    }
  }, [serial, mode, felConnected]);

  const saveEditPin = async (pinName: string) => {
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
      await loadRuntimeGpio(serial);
    } catch (err) {
      setErrorMsg(String(err));
    }
  };

  const loadFelPort = async (idx: number) => {
    const reqId = ++reqIdRef.current;
    setPortIndex(idx);
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await invoke<PioPinState[]>("read_pio_port", {
        baseAddr: parseInt(baseAddr, 16) || 0x02000000,
        portIndex: idx,
        portName: PORTS[idx],
      });
      if (reqId !== reqIdRef.current) return;
      setFelPins(res);
    } catch (err) {
      if (reqId !== reqIdRef.current) return;
      setFelPins([]);
      setErrorMsg(String(err));
    } finally {
      if (reqId === reqIdRef.current) setLoading(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 text-xs">
      <div className="ui-toolbar">
        <div className="flex items-center gap-2">
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as "adb" | "fel")}
            className="ui-select"
          >
            <option value="adb">{t("gpio.adbMode")}</option>
            <option value="fel">{t("gpio.felMode")}</option>
          </select>

          {mode === "adb" && (
            <span className="rounded-md border border-slate-200 bg-slate-100 px-2.5 py-1 font-mono text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
              Chip: {chipName}
            </span>
          )}
        </div>

        {mode === "adb" && (
          <button
            disabled={loading || !serial}
            onClick={() => loadRuntimeGpio(serial)}
            className="ui-btn-primary"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            {t("gpio.refreshData")}
          </button>
        )}
      </div>

      {errorMsg && <div className="ui-alert-warn">{errorMsg}</div>}

      {mode === "adb" ? (
        <>
          <div className="ui-card flex-1 overflow-y-auto">
            <table className="w-full text-left">
              <thead className="sticky top-0 border-b border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2.5">GPIO Pin</th>
                  <th className="px-3 py-2.5">GPIO ID</th>
                  <th className="px-3 py-2.5">Pin Function</th>
                  <th className="px-3 py-2.5">Pin MUX</th>
                  <th className="px-3 py-2.5">Pin Pull</th>
                  <th className="px-3 py-2.5">Pin Driver</th>
                  <th className="px-3 py-2.5">Pin Data</th>
                  <th className="px-3 py-2.5 text-right">{t("sector.actions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {runtimePins.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-12 text-center text-slate-500">
                      {loading ? t("gpio.readingPins") : t("gpio.noPins")}
                    </td>
                  </tr>
                ) : (
                  runtimePins.map((pin) => {
                    const isEditing = editingPin === pin.pin_name;
                    return (
                      <tr key={pin.pin_name} className={isEditing ? "bg-blue-500/10" : "hover:bg-slate-50 dark:hover:bg-slate-800/50"}>
                        <td className="px-3 py-2 font-medium text-blue-600 dark:text-blue-400">{pin.pin_name}</td>
                        <td className="px-3 py-2 font-mono">{pin.gpio_id}</td>
                        <td className="px-3 py-2">
                          {isEditing ? (
                            <select
                              value={editDraft.mux}
                              onChange={(e) => setEditDraft({ ...editDraft, mux: Number(e.target.value) })}
                              className="ui-select py-1"
                            >
                              <option value={0}>(0): GPIO_IN</option>
                              <option value={1}>(1): GPIO_OUT</option>
                              <option value={15}>(15): IO_DISABLED</option>
                            </select>
                          ) : (
                            <span className="font-semibold">{pin.function}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono">{isEditing ? editDraft.mux : pin.mux}</td>
                        <td className="px-3 py-2">
                          {isEditing ? (
                            <select
                              value={editDraft.pull}
                              onChange={(e) => setEditDraft({ ...editDraft, pull: e.target.value })}
                              className="ui-select py-1"
                            >
                              <option value="PULL DISABLE">PULL DISABLE</option>
                              <option value="Pull Up">Pull Up</option>
                              <option value="Pull Down">Pull Down</option>
                            </select>
                          ) : (
                            pin.pull
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono">
                          {isEditing ? (
                            <select
                              value={editDraft.drv}
                              onChange={(e) => setEditDraft({ ...editDraft, drv: e.target.value })}
                              className="ui-select py-1"
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
                        <td className="px-3 py-2 font-semibold">{pin.data}</td>
                        <td className="space-x-1 px-3 py-2 text-right">
                          {isEditing ? (
                            <>
                              <button onClick={() => saveEditPin(pin.pin_name)} className="rounded-md bg-emerald-500/20 p-1 text-emerald-600 dark:text-emerald-400">
                                <Check className="h-3.5 w-3.5" />
                              </button>
                              <button onClick={() => setEditingPin(null)} className="rounded-md bg-rose-500/20 p-1 text-rose-500">
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => {
                                setEditingPin(pin.pin_name);
                                setEditDraft({ mux: pin.mux, pull: pin.pull, drv: pin.drv });
                              }}
                              className="rounded-md bg-slate-100 p-1 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700"
                            >
                              <Edit2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          <div className="px-1 text-slate-500">
            {runtimePins.length} pins | Editing: {editingPin ? 1 : 0} pins
          </div>
        </>
      ) : (
        <div className="space-y-3">
          {!felConnected && (
            <div className="ui-alert-warn">
              当前未检测到处于 FEL 模式的设备；如果板卡当前为 ADB 在线，可先点击右上角「切烧录模式」或手动进入 FEL 模式。
            </div>
          )}
          <div className="ui-card flex flex-wrap items-center gap-2 p-3">
            <input
              value={baseAddr}
              onChange={(e) => {
                setBaseAddr(e.target.value);
                localStorage.setItem("gpio_base_addr", e.target.value);
              }}
              className="ui-input w-32 font-mono"
            />
            {PORTS.map((p, idx) => (
              <button
                key={p}
                disabled={!felConnected || loading}
                onClick={() => loadFelPort(idx)}
                className={
                  portIndex === idx
                    ? "ui-btn-primary"
                    : "ui-btn-secondary"
                }
              >
                {p}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-4 gap-2.5">
            {felPins.map((pin) => (
              <div key={pin.name} className="ui-card p-3">
                <div className="font-semibold text-blue-600 dark:text-blue-400">{pin.name}</div>
                <div className="mt-1 font-mono text-[11px] text-slate-600 dark:text-slate-300">
                  MUX: {pin.mux} | DATA: {pin.data} | DRV: {pin.drv} | PULL: {pin.pull}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
