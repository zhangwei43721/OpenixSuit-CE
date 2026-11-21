import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Plus, Trash2, X } from "lucide-react";
import { adbDeviceKey, resolveAdbDevice, type AdbDevice } from "./TopBar";
import {
  DeviceWorkspace,
  PowerProfile,
  SerialPortInfo,
  WorkspaceSerialSlot,
} from "../types/workbench";

interface WorkspaceModalProps {
  initial?: DeviceWorkspace | null;
  adbDevices: AdbDevice[];
  onClose: () => void;
  onSave: (ws: DeviceWorkspace) => Promise<void>;
}

export function WorkspaceModal({
  initial,
  adbDevices,
  onClose,
  onSave,
}: WorkspaceModalProps) {
  const [name, setName] = useState(initial?.name || "");
  const [chip, setChip] = useState(initial?.chip || "V861");
  const [adbSerial, setAdbSerial] = useState(initial?.adb_serial || "");
  const adbBoundDevice = resolveAdbDevice(adbSerial, adbDevices);
  const [workspaceDir, setWorkspaceDir] = useState(initial?.workspace_dir || "");
  const [powerProfileId, setPowerProfileId] = useState(initial?.power_profile_id || "");
  const [notes, setNotes] = useState(initial?.notes || "");
  const [serialPorts, setSerialPorts] = useState<WorkspaceSerialSlot[]>(
    initial?.serial_ports?.length
      ? initial.serial_ports
      : [{ label: "Linux", port_name: "", baud_rate: 115200 }]
  );
  const [hostPorts, setHostPorts] = useState<SerialPortInfo[]>([]);
  const [powerProfiles, setPowerProfiles] = useState<PowerProfile[]>([]);

  useEffect(() => {
    invoke<SerialPortInfo[]>("serial_list_ports")
      .then((res) => setHostPorts(Array.isArray(res) ? res : []))
      .catch(() => {});
    invoke<PowerProfile[]>("power_list_profiles")
      .then((res) => setPowerProfiles(Array.isArray(res) ? res : []))
      .catch(() => {});
  }, []);

  const pickDir = async () => {
    try {
      const dir = await open({ directory: true });
      if (typeof dir === "string") setWorkspaceDir(dir);
    } catch {
      // ignore
    }
  };

  const handleSubmit = async () => {
    if (!name.trim()) return;
    await onSave({
      id: initial?.id || `ws-${Date.now()}`,
      name: name.trim(),
      chip: chip.trim(),
      adb_serial: adbBoundDevice ? adbDeviceKey(adbBoundDevice) : adbSerial.trim(),
      workspace_dir: workspaceDir.trim(),
      power_profile_id: powerProfileId.trim(),
      serial_ports: serialPorts.filter((s) => s.port_name.trim() || s.label.trim()),
      notes: notes.trim(),
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[1px]">
      <div className="w-full max-w-lg space-y-3.5 rounded-xl border border-slate-200 bg-white p-5 text-xs shadow-xl dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-200 pb-2.5 dark:border-slate-800">
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {initial ? "编辑设备工作区" : "添加设备工作区"}
          </span>
          <button onClick={onClose} className="rounded-lg p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="mb-1 text-[11px] text-slate-500">设备名称</div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如 V861 眼镜主板"
              className="ui-input w-full"
            />
          </div>
          <div>
            <div className="mb-1 text-[11px] text-slate-500">芯片平台</div>
            <input
              value={chip}
              onChange={(e) => setChip(e.target.value)}
              placeholder="V861 / V881 / V821"
              className="ui-input w-full"
            />
          </div>
          <div>
            <div className="mb-1 text-[11px] text-slate-500">绑定 ADB 设备</div>
            <select
              value={adbBoundDevice ? adbDeviceKey(adbBoundDevice) : adbSerial}
              onChange={(e) => setAdbSerial(e.target.value)}
              className="ui-select w-full"
            >
              <option value="">自动匹配当前在线 ADB</option>
              {adbSerial && !adbBoundDevice && <option value={adbSerial}>{adbSerial}（不可用）</option>}
              {adbDevices.map((d) => (
                <option key={adbDeviceKey(d)} value={adbDeviceKey(d)}>
                  {d.serial}{d.usb_path ? ` · ${d.usb_path}` : ""} ({d.state})
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className="mb-1 text-[11px] text-slate-500">关联程控电源</div>
            <select
              value={powerProfileId}
              onChange={(e) => setPowerProfileId(e.target.value)}
              className="ui-select w-full"
            >
              <option value="">不绑定</option>
              {powerProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.kind})
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <div className="mb-1 text-[11px] text-slate-500">设备工作区目录</div>
          <div className="flex gap-2">
            <input
              value={workspaceDir}
              onChange={(e) => setWorkspaceDir(e.target.value)}
              placeholder="/path/to/board-workspace"
              className="ui-input flex-1 font-mono"
            />
            <button
              type="button"
              onClick={pickDir}
              className="ui-btn-secondary"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              浏览
            </button>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-slate-500">绑定串口列表</span>
            <button
              type="button"
              onClick={() =>
                setSerialPorts((prev) => [
                  ...prev,
                  { label: `UART${prev.length + 1}`, port_name: "", baud_rate: 115200 },
                ])
              }
              className="ui-btn-primary px-2.5 py-1 text-[11px]"
            >
              <Plus className="h-3 w-3" />
              新增串口
            </button>
          </div>
          {serialPorts.map((slot, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <input
                value={slot.label}
                onChange={(e) =>
                  setSerialPorts((prev) =>
                    prev.map((s, i) => (i === idx ? { ...s, label: e.target.value } : s))
                  )
                }
                placeholder="标签 (Linux/RTOS)"
                className="ui-input w-28"
              />
              <select
                value={slot.port_name}
                onChange={(e) =>
                  setSerialPorts((prev) =>
                    prev.map((s, i) => (i === idx ? { ...s, port_name: e.target.value } : s))
                  )
                }
                className="ui-select flex-1"
              >
                <option value="">选择串口...</option>
                {hostPorts.map((hp) => (
                  <option key={hp.port_name} value={hp.port_name}>
                    {hp.port_name} {hp.product ? `(${hp.product})` : ""}
                  </option>
                ))}
              </select>
              <select
                value={slot.baud_rate}
                onChange={(e) =>
                  setSerialPorts((prev) =>
                    prev.map((s, i) =>
                      i === idx ? { ...s, baud_rate: Number(e.target.value) } : s
                    )
                  )
                }
                className="ui-select w-24"
              >
                {[9600, 115200, 460800, 921600, 1500000].map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setSerialPorts((prev) => prev.filter((_, i) => i !== idx))}
                className="rounded-lg p-1.5 text-rose-500 hover:bg-rose-500/10"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>

        <div>
          <div className="mb-1 text-[11px] text-slate-500">备注</div>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="可选硬件说明..."
            className="ui-input w-full"
          />
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-3 dark:border-slate-800">
          <button
            type="button"
            onClick={onClose}
            className="ui-btn-secondary"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            className="ui-btn-primary px-4"
          >
            保存工作区
          </button>
        </div>
      </div>
    </div>
  );
}
