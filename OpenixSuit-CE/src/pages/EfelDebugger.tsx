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
      pushLog(`Scan devices: ${list.length}`);
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
    <div className="grid h-full grid-cols-12 gap-4">
      <div className="col-span-4 space-y-3 overflow-y-auto text-xs">
        <div className="space-y-2 rounded border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900">
          <div className="font-semibold text-blue-600 dark:text-blue-400">{t("efel.deviceSel")}</div>
          <button onClick={scanDevices} className="w-full rounded bg-blue-600 py-1.5 text-white">
            {t("efel.scan")}
          </button>
          <div className="text-slate-500">
            {devices.length === 0 ? t("flash.noDevice") : devices.map((d) => `${d.chip} (${d.mode})`).join(", ")}
          </div>
        </div>

        <div className="space-y-2 rounded border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900">
          <div className="font-semibold text-blue-600 dark:text-blue-400">{t("efel.memRead")}</div>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            className="w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono dark:border-slate-700 dark:bg-slate-950"
          />
          <input
            type="number"
            value={length}
            onChange={(e) => setLength(Number(e.target.value))}
            className="w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-950"
          />
          <div className="flex gap-2">
            <button
              disabled={loading}
              onClick={readAndDisasm}
              className="flex-1 rounded bg-blue-600 py-1.5 text-white disabled:opacity-50"
            >
              {loading ? t("efel.reading") : t("efel.read")}
            </button>
            <button
              disabled={rawBytes.length === 0}
              onClick={saveBinary}
              className="rounded border border-slate-300 bg-white px-3 py-1.5 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800"
            >
              {t("efel.saveBin")}
            </button>
          </div>
        </div>

        <div className="space-y-2 rounded border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900">
          <div className="font-semibold text-blue-600 dark:text-blue-400">{t("efel.memWrite")}</div>
          <input
            value={writeAddr}
            onChange={(e) => setWriteAddr(e.target.value)}
            className="w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono dark:border-slate-700 dark:bg-slate-950"
          />
          <div className="flex gap-2">
            <input
              readOnly
              value={writeFilePath}
              placeholder="..."
              className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-950"
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
              className="rounded bg-blue-600 px-2.5 py-1 text-white"
            >
              {t("common.browse")}
            </button>
          </div>
          <button
            disabled={!writeFilePath}
            onClick={doWriteFile}
            className="w-full rounded bg-blue-600 py-1.5 text-white disabled:opacity-50"
          >
            {t("efel.write")}
          </button>
        </div>

        <div className="space-y-2 rounded border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900">
          <div className="font-semibold text-blue-600 dark:text-blue-400">{t("efel.initMem")}</div>
          <div className="flex gap-2">
            <input
              readOnly
              value={initFilePath}
              placeholder="Boot0 / FEX..."
              className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-950"
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
              className="rounded bg-blue-600 px-2.5 py-1 text-white"
            >
              {t("common.browse")}
            </button>
          </div>
          <button
            disabled={!initFilePath}
            onClick={doInitDram}
            className="w-full rounded bg-blue-600 py-1.5 text-white disabled:opacity-50"
          >
            {t("efel.run")}
          </button>
        </div>

        <div className="space-y-2 rounded border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900">
          <div className="font-semibold text-blue-600 dark:text-blue-400">{t("efel.execJump")}</div>
          <div className="flex gap-2">
            <input
              value={jumpAddr}
              onChange={(e) => setJumpAddr(e.target.value)}
              className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 font-mono dark:border-slate-700 dark:bg-slate-950"
            />
            <button onClick={doJump} className="rounded bg-blue-600 px-3 py-1 text-white">
              {t("efel.jump")}
            </button>
          </div>
        </div>
      </div>

      <div className="col-span-8 flex flex-col space-y-3">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold">{t("efel.memView")}</span>
          <select
            value={arch}
            onChange={(e) => {
              setArch(e.target.value);
              localStorage.setItem("efel_arch", e.target.value);
            }}
            className="rounded border border-slate-300 bg-white px-2.5 py-1 dark:border-slate-700 dark:bg-slate-800"
          >
            <option value="riscv32">RISC-V 32</option>
            <option value="riscv64">RISC-V 64</option>
            <option value="arm32">ARM32</option>
            <option value="aarch64">AArch64</option>
            <option value="mips">MIPS32</option>
            <option value="x86_64">x86-64</option>
          </select>
        </div>
        <div className="flex-1 overflow-hidden rounded border border-slate-300 dark:border-slate-800">
          <Editor
            height="100%"
            defaultLanguage="plaintext"
            theme={theme === "dark" ? "vs-dark" : "vs"}
            value={viewText}
            options={{ readOnly: true, minimap: { enabled: false }, fontSize: 12 }}
          />
        </div>
        <pre className="h-28 overflow-y-auto rounded border border-slate-200 bg-slate-900 p-2.5 font-mono text-xs text-slate-300 dark:border-slate-800 dark:bg-slate-950">
          {opLogs.join("\n") || "OPERATION LOG"}
        </pre>
      </div>
    </div>
  );
}
