import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import Editor from "@monaco-editor/react";
import { useTranslation } from "react-i18next";

interface DisasmInsn {
  address: string;
  mnemonic: string;
  op_str: string;
}

interface DeviceInfo {
  id: string;
  chip: string;
  mode: string;
}

export function EfelDebugger({
  theme,
  onLog,
}: {
  theme: "dark" | "light";
  onLog: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [address, setAddress] = useState(() => localStorage.getItem("efel_address") || "0x001003c8");
  const [length, setLength] = useState(() => Number(localStorage.getItem("efel_length")) || 256);
  const [arch, setArch] = useState(() => localStorage.getItem("efel_arch") || "riscv32");
  const [writeAddr, setWriteAddr] = useState("0x00000000");
  const [writeFilePath, setWriteFilePath] = useState("");
  const [initFilePath, setInitFilePath] = useState("");
  const [jumpAddr, setJumpAddr] = useState("0x00000000");
  const [rawBytes, setRawBytes] = useState<number[]>([]);
  const [viewText, setViewText] = useState("; Hex + ASCII + Disassembly");
  const [opLogs, setOpLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const pushLog = (msg: string) => {
    setOpLogs((p) => [...p.slice(-99), `[${new Date().toLocaleTimeString()}] ${msg}`]);
    onLog(msg);
  };

  const scanDevices = async () => {
    try {
      const list = await invoke<DeviceInfo[]>("scan_devices");
      setDevices(list);
      if (list.length === 0) {
        pushLog("Scan devices: 0");
      } else {
        const desc = list.map((d) => `${d.chip} [${d.mode}]`).join("; ");
        pushLog(`Scan devices: ${list.length} -> ${desc}`);
      }
    } catch (err) {
      pushLog(String(err));
    }
  };

  const readAndDisasm = async () => {
    setLoading(true);
    localStorage.setItem("efel_address", address);
    localStorage.setItem("efel_length", String(length));
    localStorage.setItem("efel_arch", arch);
    try {
      const addrNum = parseInt(address, 16) || 0;
      const bytes = await invoke<number[]>("fel_read_mem", { address: addrNum, length });
      setRawBytes(bytes);
      const insns = await invoke<DisasmInsn[]>("disassemble_bytes", {
        arch,
        baseAddr: addrNum,
        bytes,
      });
      const insnMap = new Map(insns.map((i) => [i.address.toLowerCase(), `${i.mnemonic.padEnd(8)} ${i.op_str}`]));
      const lines: string[] = [];
      for (let off = 0; off < bytes.length; off += 4) {
        const curAddr = `0x${(addrNum + off).toString(16).padStart(8, "0")}`;
        const slice = bytes.slice(off, off + 4);
        const hex = slice.map((b) => b.toString(16).padStart(2, "0")).join(" ").padEnd(11);
        const ascii = slice.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
        const asm = insnMap.get(curAddr.toLowerCase()) || "";
        lines.push(`${curAddr}  ${hex}  ${ascii.padEnd(5)}  ${asm}`);
      }
      setViewText(lines.join("\n"));
      pushLog(`Read success: ${bytes.length} bytes at ${address} (${arch})`);
    } catch (err) {
      pushLog(String(err));
    } finally {
      setLoading(false);
    }
  };

  const saveBinary = async () => {
    if (rawBytes.length === 0) return;
    try {
      const outPath = await save({ defaultPath: `mem_${address}.bin` });
      if (outPath) {
        await writeFile(outPath, new Uint8Array(rawBytes));
        pushLog(`Saved -> ${outPath}`);
      }
    } catch (err) {
      pushLog(String(err));
    }
  };

  const doWriteFile = async () => {
    if (!writeFilePath) return;
    try {
      const addrNum = parseInt(writeAddr, 16) || 0;
      const written = await invoke<number>("fel_write_file", {
        address: addrNum,
        filePath: writeFilePath,
      });
      pushLog(`Write success: ${written} bytes -> ${writeAddr}`);
    } catch (err) {
      pushLog(String(err));
    }
  };

  const doInitDram = async () => {
    if (!initFilePath) return;
    try {
      const lines = await invoke<string[]>("fel_init_dram", { filePath: initFilePath });
      lines.forEach(pushLog);
    } catch (err) {
      pushLog(String(err));
    }
  };

  const doJump = async () => {
    try {
      const addrNum = parseInt(jumpAddr, 16) || 0;
      await invoke("fel_exec", { address: addrNum });
      pushLog(`Executed jump -> ${jumpAddr}`);
    } catch (err) {
      pushLog(String(err));
    }
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-12 gap-4">
      <div className="col-span-4 space-y-4 overflow-y-auto pr-0.5 text-xs">
        <div className="ui-card overflow-hidden">
          <div className="ui-card-header">
            <span className="ui-title text-blue-600 dark:text-blue-400">{t("efel.deviceSel")}</span>
            <span className="rounded-md bg-slate-200/70 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              {devices.length}
            </span>
          </div>
          <div className="space-y-3 p-4">
            <button onClick={scanDevices} className="ui-btn-primary w-full py-2">
              {t("efel.scan")}
            </button>
            <div className="space-y-1.5 text-slate-500 dark:text-slate-400">
              {devices.length === 0 ? (
                <div className="ui-subcard p-3 text-center text-slate-500 dark:text-slate-400">
                  {t("flash.noDevice")}
                </div>
              ) : (
                devices.map((d) => {
                  const isFes = d.mode.toUpperCase().includes("FES");
                  return (
                    <div
                      key={d.id}
                      className={`rounded-lg border px-3 py-2 ${
                        isFes
                          ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                          : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      }`}
                    >
                      <div className="flex items-center gap-2 font-mono font-medium tabular-nums">
                        <span
                          className={`h-2 w-2 rounded-full ${
                            isFes ? "bg-amber-500" : "bg-emerald-500"
                          }`}
                        />
                        <span>
                          {d.chip} · {d.mode}
                        </span>
                      </div>
                      {isFes && (
                        <div className="mt-1 text-[11px] opacity-90">
                          当前为 FES 模式，仅支持刷机；读取内存需按住 FEL 键上电进入 FEL 模式
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        <div className="ui-card overflow-hidden">
          <div className="ui-card-header">
            <span className="ui-title text-blue-600 dark:text-blue-400">{t("efel.memRead")}</span>
          </div>
          <div className="space-y-3 p-4">
            <div className="grid grid-cols-2 gap-2.5">
              <label className="flex flex-col gap-1.5">
                <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                  Address (Hex)
                </span>
                <input
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  className="ui-input w-full font-mono tabular-nums"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                  Length (Bytes)
                </span>
                <input
                  type="number"
                  value={length}
                  onChange={(e) => setLength(Number(e.target.value))}
                  className="ui-input w-full font-mono tabular-nums"
                />
              </label>
            </div>
            <div className="flex gap-2">
              <button
                disabled={loading}
                onClick={readAndDisasm}
                className="ui-btn-primary flex-1"
              >
                {loading ? t("efel.reading") : t("efel.read")}
              </button>
              <button
                disabled={rawBytes.length === 0}
                onClick={saveBinary}
                className="ui-btn-secondary shrink-0"
              >
                {t("efel.saveBin")}
              </button>
            </div>
          </div>
        </div>

        <div className="ui-card overflow-hidden">
          <div className="ui-card-header">
            <span className="ui-title text-blue-600 dark:text-blue-400">{t("efel.memWrite")}</span>
          </div>
          <div className="space-y-3 p-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                Address (Hex)
              </span>
              <input
                value={writeAddr}
                onChange={(e) => setWriteAddr(e.target.value)}
                className="ui-input w-full font-mono tabular-nums"
              />
            </label>
            <div className="flex gap-2">
              <input
                readOnly
                value={writeFilePath}
                placeholder="..."
                className="ui-input flex-1 font-mono"
              />
              <button
                onClick={async () => {
                  try {
                    const f = await open();
                    if (typeof f === "string") setWriteFilePath(f);
                  } catch (err) {
                    pushLog(String(err));
                  }
                }}
                className="ui-btn-secondary shrink-0"
              >
                {t("common.browse")}
              </button>
            </div>
            <button
              disabled={!writeFilePath}
              onClick={doWriteFile}
              className="ui-btn-primary w-full"
            >
              {t("efel.write")}
            </button>
          </div>
        </div>

        <div className="ui-card overflow-hidden">
          <div className="ui-card-header">
            <span className="ui-title text-blue-600 dark:text-blue-400">{t("efel.initMem")}</span>
          </div>
          <div className="space-y-3 p-4">
            <div className="flex gap-2">
              <input
                readOnly
                value={initFilePath}
                placeholder="Boot0 / FEX..."
                className="ui-input flex-1 font-mono"
              />
              <button
                onClick={async () => {
                  try {
                    const f = await open();
                    if (typeof f === "string") setInitFilePath(f);
                  } catch (err) {
                    pushLog(String(err));
                  }
                }}
                className="ui-btn-secondary shrink-0"
              >
                {t("common.browse")}
              </button>
            </div>
            <button
              disabled={!initFilePath}
              onClick={doInitDram}
              className="ui-btn-primary w-full"
            >
              {t("efel.run")}
            </button>
          </div>
        </div>

        <div className="ui-card overflow-hidden">
          <div className="ui-card-header">
            <span className="ui-title text-blue-600 dark:text-blue-400">{t("efel.execJump")}</span>
          </div>
          <div className="p-4">
            <div className="flex gap-2">
              <input
                value={jumpAddr}
                onChange={(e) => setJumpAddr(e.target.value)}
                className="ui-input flex-1 font-mono tabular-nums"
              />
              <button onClick={doJump} className="ui-btn-primary shrink-0">
                {t("efel.jump")}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="col-span-8 flex min-h-0 flex-col gap-4">
        <div className="ui-toolbar">
          <div className="flex items-center gap-2">
            <span className="ui-title">{t("efel.memView")}</span>
            {rawBytes.length > 0 && (
              <span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-[11px] tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {rawBytes.length} B
              </span>
            )}
          </div>
          <select
            value={arch}
            onChange={(e) => {
              setArch(e.target.value);
              localStorage.setItem("efel_arch", e.target.value);
            }}
            className="ui-select"
          >
            <option value="riscv32">RISC-V 32</option>
            <option value="riscv64">RISC-V 64</option>
            <option value="arm32">ARM32</option>
            <option value="aarch64">AArch64</option>
            <option value="mips">MIPS32</option>
            <option value="x86_64">x86-64</option>
          </select>
        </div>
        <div className="ui-card flex-1 min-h-0 overflow-hidden">
          <Editor
            height="100%"
            defaultLanguage="plaintext"
            theme={theme === "dark" ? "vs-dark" : "vs"}
            value={viewText}
            options={{ readOnly: true, minimap: { enabled: false }, fontSize: 12 }}
          />
        </div>
        <pre className="ui-terminal h-28 overflow-y-auto p-3 tabular-nums text-slate-300">
          {opLogs.join("\n") || "OPERATION LOG"}
        </pre>
      </div>
    </div>
  );
}
