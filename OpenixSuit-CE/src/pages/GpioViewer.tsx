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
    <div className="flex h-full flex-col space-y-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as "adb" | "fel")}
            className="rounded border border-slate-300 bg-white px-2.5 py-1 text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            <option value="adb">{t("gpio.adbMode")}</option>
            <option value="fel">{t("gpio.felMode")}</option>
          </select>

          {mode === "adb" && (
            <span className="rounded bg-slate-200 px-2.5 py-1 dark:bg-slate-800">
              Chip: {chipName}
            </span>
          )}
        </div>

        {mode === "adb" && (
          <button
            disabled={loading || !serial}
            onClick={() => loadRuntimeGpio(serial)}
            className="flex items-center gap-1 rounded bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-500 disabled:opacity-50"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t("gpio.refreshData")}
          </button>
        )}
      </div>

      {errorMsg && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-600 dark:text-amber-400">
          {errorMsg}
        </div>
      )}

      {mode === "adb" ? (
        <>
          <div className="flex-1 overflow-y-auto rounded border border-slate-200 dark:border-slate-800">
            <table className="w-full text-left">
              <thead className="sticky top-0 bg-slate-100 text-slate-600 dark:bg-slate-900 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2">GPIO Pin</th>
                  <th className="px-3 py-2">GPIO ID</th>
                  <th className="px-3 py-2">Pin Function</th>
                  <th className="px-3 py-2">Pin MUX</th>
                  <th className="px-3 py-2">Pin Pull</th>
                  <th className="px-3 py-2">Pin Driver</th>
                  <th className="px-3 py-2">Pin Data</th>
                  <th className="px-3 py-2 text-right">{t("sector.actions")}</th>
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
                      <tr key={pin.pin_name} className={isEditing ? "bg-blue-500/10" : "hover:bg-slate-50 dark:hover:bg-slate-900/50"}>
                        <td className="px-3 py-1.5 font-medium text-blue-600 dark:text-blue-400">{pin.pin_name}</td>
                        <td className="px-3 py-1.5 font-mono">{pin.gpio_id}</td>
                        <td className="px-3 py-1.5">
                          {isEditing ? (
                            <select
                              value={editDraft.mux}
                              onChange={(e) => setEditDraft({ ...editDraft, mux: Number(e.target.value) })}
                              className="rounded border border-slate-400 bg-white px-2 py-0.5 text-slate-900 dark:bg-slate-800 dark:text-slate-100"
                            >
                              <option value={0}>(0): GPIO_IN</option>
                              <option value={1}>(1): GPIO_OUT</option>
                              <option value={15}>(15): IO_DISABLED</option>
                            </select>
                          ) : (
                            <span className="font-semibold">{pin.function}</span>
                          )}
                        </td>
                        <td className="px-3 py-1.5 font-mono">{isEditing ? editDraft.mux : pin.mux}</td>
                        <td className="px-3 py-1.5">
                          {isEditing ? (
                            <select
                              value={editDraft.pull}
                              onChange={(e) => setEditDraft({ ...editDraft, pull: e.target.value })}
                              className="rounded border border-slate-400 bg-white px-2 py-0.5 text-slate-900 dark:bg-slate-800 dark:text-slate-100"
                            >
                              <option value="PULL DISABLE">PULL DISABLE</option>
                              <option value="Pull Up">Pull Up</option>
                              <option value="Pull Down">Pull Down</option>
                            </select>
                          ) : (
                            pin.pull
                          )}
                        </td>
                        <td className="px-3 py-1.5 font-mono">
                          {isEditing ? (
                            <select
                              value={editDraft.drv}
                              onChange={(e) => setEditDraft({ ...editDraft, drv: e.target.value })}
                              className="rounded border border-slate-400 bg-white px-2 py-0.5 text-slate-900 dark:bg-slate-800 dark:text-slate-100"
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
                        <td className="px-3 py-1.5 font-semibold">{pin.data}</td>
                        <td className="space-x-1 px-3 py-1.5 text-right">
                          {isEditing ? (
                            <>
                              <button onClick={() => saveEditPin(pin.pin_name)} className="rounded bg-emerald-500/20 p-1 text-emerald-500">
                                <Check className="h-3.5 w-3.5" />
                              </button>
                              <button onClick={() => setEditingPin(null)} className="rounded bg-red-500/20 p-1 text-red-500">
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => {
                                setEditingPin(pin.pin_name);
                                setEditDraft({ mux: pin.mux, pull: pin.pull, drv: pin.drv });
                              }}
                              className="rounded bg-slate-200 p-1 hover:bg-slate-300 dark:bg-slate-800"
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
          <div className="text-slate-500">
            {runtimePins.length} pins | Editing: {editingPin ? 1 : 0} pins
          </div>
        </>
      ) : (
        <div className="space-y-3">
          {!felConnected && (
            <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-600 dark:text-amber-400">
              当前未检测到处于 FEL 模式的设备；如果板卡当前为 ADB 在线，可先点击右上角「切烧录模式」或手动进入 FEL 模式。
            </div>
          )}
          <div className="flex items-center gap-2">
            <input
              value={baseAddr}
              onChange={(e) => {
                setBaseAddr(e.target.value);
                localStorage.setItem("gpio_base_addr", e.target.value);
              }}
              className="w-32 rounded border border-slate-300 bg-white px-2.5 py-1 font-mono dark:border-slate-700 dark:bg-slate-900"
            />
            {PORTS.map((p, idx) => (
              <button
                key={p}
                disabled={!felConnected || loading}
                onClick={() => loadFelPort(idx)}
                className={`rounded px-3 py-1 disabled:opacity-40 ${portIndex === idx ? "bg-blue-600 text-white" : "bg-slate-200 dark:bg-slate-800"}`}
              >
                {p}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-4 gap-2">
            {felPins.map((pin) => (
              <div key={pin.name} className="rounded border border-slate-200 bg-slate-50 p-2 dark:border-slate-800 dark:bg-slate-900">
                <div className="font-semibold text-blue-500">{pin.name}</div>
                <div>MUX: {pin.mux} | DATA: {pin.data} | DRV: {pin.drv} | PULL: {pin.pull}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
