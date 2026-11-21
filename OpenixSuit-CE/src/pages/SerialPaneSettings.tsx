import { useTranslation } from "react-i18next";
import { adbDeviceKey, resolveAdbDevice, type AdbDevice } from "../components/TopBar";
import type { SerialCharset, SerialFormat, SerialLineEnding, SerialPortInfo } from "../types/workbench";
import type { SerialPaneState } from "./SerialPage";

export const BAUD_RATES = [
  1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 74880, 115200,
  230400, 250000, 460800, 500000, 576000, 921600, 1000000, 1500000, 2000000, 3000000,
];
const CUSTOM_BAUD = "__custom__";
const CHARSETS: SerialCharset[] = ["utf-8", "gb18030", "big5", "latin1"];
const FIELD = "flex min-w-0 flex-col gap-1.5 text-xs text-slate-600 dark:text-slate-300";
const CHECKBOX = "flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300";
const TITLE = "mb-2 text-xs font-semibold text-slate-800 dark:text-slate-200";

interface SerialPaneSettingsProps {
  pane: SerialPaneState;
  paneNumber: number;
  ports: readonly SerialPortInfo[];
  adbDevices: readonly AdbDevice[];
  adbSerial: string;
  onChange: (patch: Partial<SerialPaneState>) => void;
  onToggleSignal: (kind: "dtr" | "rts") => void;
}

export function SerialPaneSettings({
  pane,
  paneNumber,
  ports,
  adbDevices,
  adbSerial,
  onChange,
  onToggleSignal,
}: SerialPaneSettingsProps) {
  const { t, i18n } = useTranslation();
  const isEn = i18n.language.startsWith("en");
  const isAdb = pane.source === "adb";
  const busy = pane.connected || pane.connecting || pane.stopping || pane.resumeConnected;
  const hasPort = ports.some((port) => port.port_name === pane.portName);
  const adbDevice = resolveAdbDevice(adbSerial, adbDevices);

  return (
    <div className="min-w-0 space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={FIELD}>
          {t("multiLog.paneLabel")}
          <input
            value={pane.label ?? ""}
            placeholder={t("multiLog.paneName", { number: paneNumber })}
            onChange={(event) => onChange({ label: event.target.value })}
            className="ui-input w-full"
          />
        </label>
        <label className={FIELD}>
          {t("multiLog.source")}
          <select
            value={pane.source}
            disabled={busy}
            onChange={(event) => onChange({
              source: event.target.value === "adb" ? "adb" : "serial",
              lines: [],
              hexRows: [],
              endsWithNewline: true,
              followPaused: false,
              error: null,
            })}
            className="ui-select w-full"
          >
            <option value="serial">{t("multiLog.serialSource")}</option>
            <option value="adb">{t("multiLog.adbSource")}</option>
          </select>
        </label>
        {isAdb ? (
          <>
            <label className={FIELD}>
              {t("multiLog.adbDevice")}
              <select
                value={adbDevice ? adbDeviceKey(adbDevice) : adbSerial}
                disabled={busy}
                onChange={(event) => onChange({ adbSerial: event.target.value })}
                className="ui-select w-full font-mono"
              >
                <option value="">{t("multiLog.pickAdb")}</option>
                {adbDevices.map((device) => (
                  <option key={adbDeviceKey(device)} value={adbDeviceKey(device)}>
                    {device.serial}{device.usb_path ? ` · ${device.usb_path}` : ""}
                  </option>
                ))}
                {adbSerial && !adbDevice && (
                  <option value={adbSerial}>{t("multiLog.adbMissing", { serial: adbSerial })}</option>
                )}
              </select>
            </label>
            <label className={FIELD}>
              {t("multiLog.adbCommand")}
              <input
                value={pane.adbCommand}
                disabled={busy}
                onChange={(event) => onChange({ adbCommand: event.target.value })}
                placeholder={t("multiLog.adbExample")}
                className="ui-input w-full font-mono"
              />
            </label>
          </>
        ) : (
          <>
            <label className={FIELD}>
              {t("multiLog.serialPort")}
              <select
                value={pane.portName}
                disabled={busy}
                onChange={(event) => onChange({ portName: event.target.value })}
                className="ui-select w-full font-mono"
              >
                <option value="">{isEn ? "Select a port" : "选择串口"}</option>
                {ports.map((port) => (
                  <option key={port.port_name} value={port.port_name}>
                    {port.port_name}{port.product ? ` (${port.product})` : ""}
                  </option>
                ))}
                {pane.portName && !hasPort && <option value={pane.portName}>{pane.portName}</option>}
              </select>
            </label>
            <div className="grid min-w-0 grid-cols-2 gap-2">
              <label className={`${FIELD} ${pane.customBaud ? "" : "col-span-2"}`}>
                {isEn ? "Baud rate" : "波特率"}
                <select
                  value={pane.customBaud ? CUSTOM_BAUD : pane.baudRate}
                  disabled={busy}
                  onChange={(event) => {
                    const value = event.target.value;
                    onChange(value === CUSTOM_BAUD
                      ? { customBaud: true }
                      : { customBaud: false, baudRate: Number(value) });
                  }}
                  className="ui-select w-full font-mono tabular-nums"
                >
                  {BAUD_RATES.map((rate) => <option key={rate} value={rate}>{rate}</option>)}
                  <option value={CUSTOM_BAUD}>{isEn ? "Custom" : "自定义"}</option>
                </select>
              </label>
              {pane.customBaud && (
                <label className={FIELD}>
                  {isEn ? "Custom baud rate" : "自定义波特率"}
                  <input
                    type="number"
                    min={1}
                    max={4000000}
                    value={pane.baudRate}
                    disabled={busy}
                    onChange={(event) => onChange({
                      baudRate: Math.max(1, Math.floor(Number(event.target.value) || 0)),
                    })}
                    className="ui-input w-full font-mono tabular-nums"
                  />
                </label>
              )}
            </div>
          </>
        )}
      </div>

      {!isAdb && (
        <section className="border-t border-slate-200 pt-3 dark:border-slate-800">
          <h3 className={TITLE}>{isEn ? "Serial line" : "线路参数"}</h3>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <label className={FIELD}>
              {isEn ? "Data bits" : "数据位"}
              <select
                value={pane.coding.data_bits}
                disabled={busy}
                onChange={(event) => onChange({ coding: { ...pane.coding, data_bits: Number(event.target.value) } })}
                className="ui-select w-full font-mono"
              >
                {[5, 6, 7, 8].map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label className={FIELD}>
              {isEn ? "Parity" : "校验位"}
              <select
                value={pane.coding.parity}
                disabled={busy}
                onChange={(event) => onChange({ coding: { ...pane.coding, parity: event.target.value } })}
                className="ui-select w-full"
              >
                <option value="none">{isEn ? "No parity" : "无校验"}</option>
                <option value="even">{isEn ? "Even" : "偶校验"}</option>
                <option value="odd">{isEn ? "Odd" : "奇校验"}</option>
              </select>
            </label>
            <label className={FIELD}>
              {isEn ? "Stop bits" : "停止位"}
              <select
                value={pane.coding.stop_bits}
                disabled={busy}
                onChange={(event) => onChange({ coding: { ...pane.coding, stop_bits: Number(event.target.value) } })}
                className="ui-select w-full font-mono"
              >
                {[1, 2].map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label className={FIELD}>
              {isEn ? "Flow control" : "流控"}
              <select
                value={pane.coding.flow_control}
                disabled={busy}
                onChange={(event) => onChange({ coding: { ...pane.coding, flow_control: event.target.value } })}
                className="ui-select w-full"
              >
                <option value="none">{isEn ? "No flow" : "无流控"}</option>
                <option value="software">{isEn ? "XON/XOFF" : "软流控 (XON/XOFF)"}</option>
                <option value="hardware">{isEn ? "RTS/CTS" : "硬流控 (RTS/CTS)"}</option>
              </select>
            </label>
          </div>
          <div className="mt-3 flex items-center gap-2">
            {(["dtr", "rts"] as const).map((signal) => (
              <button
                key={signal}
                type="button"
                aria-pressed={pane[signal]}
                onClick={() => onToggleSignal(signal)}
                disabled={!pane.connected || pane.stopping}
                className={`ui-btn-secondary px-2 py-1 font-mono ${pane[signal] ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300" : ""}`}
              >
                {signal.toUpperCase()}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-3 border-t border-slate-200 pt-3 dark:border-slate-800">
        {!isAdb && (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <label className={FIELD}>
              {t("multiLog.receiveFormat")}
              <select
                value={pane.receiveFormat}
                onChange={(event) => onChange({ receiveFormat: event.target.value as SerialFormat })}
                className="ui-select w-full"
              >
                <option value="text">{t("multiLog.formatText")}</option>
                <option value="hex">{t("multiLog.formatHex")}</option>
              </select>
            </label>
            <label className={FIELD}>
              {isEn ? "Receive charset" : "接收字符集"}
              <select
                value={pane.charset}
                onChange={(event) => onChange({ charset: event.target.value as SerialCharset })}
                className="ui-select w-full font-mono"
              >
                {CHARSETS.map((charset) => <option key={charset} value={charset}>{charset.toUpperCase()}</option>)}
              </select>
            </label>
            <label className={FIELD}>
              {t("multiLog.sendFormat")}
              <select
                value={pane.sendFormat}
                onChange={(event) => onChange({ sendFormat: event.target.value as SerialFormat, historyIndex: -1 })}
                className="ui-select w-full"
              >
                <option value="text">{t("multiLog.formatText")}</option>
                <option value="hex">{t("multiLog.formatHex")}</option>
              </select>
            </label>
            <label className={FIELD}>
              {t("multiLog.sendLineEnding")}
              <select
                value={pane.lineEnding}
                disabled={pane.sendFormat === "hex"}
                onChange={(event) => onChange({ lineEnding: event.target.value as SerialLineEnding })}
                className="ui-select w-full font-mono"
              >
                <option value="lf">LF</option>
                <option value="crlf">CRLF</option>
                <option value="cr">CR</option>
                <option value="none">{t("multiLog.noLineEnding")}</option>
              </select>
            </label>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <label className={CHECKBOX}>
            <input type="checkbox" checked={pane.showTimestamps} onChange={(event) => onChange({ showTimestamps: event.target.checked })} />
            {isEn ? "Show timestamps" : "显示时间戳"}
          </label>
          <label className={CHECKBOX}>
            <input type="checkbox" checked={pane.ansiEnabled} onChange={(event) => onChange({ ansiEnabled: event.target.checked })} />
            {isEn ? "ANSI colors" : "ANSI 彩色"}
          </label>
          <label className={CHECKBOX}>
            <input
              type="checkbox"
              checked={pane.autoScroll}
              onChange={(event) => onChange({ autoScroll: event.target.checked, followPaused: false })}
            />
            {t("multiLog.autoScroll")}
          </label>
        </div>
      </section>
    </div>
  );
}
