import type { SerialLineEnding } from "../types/workbench";

export interface BufferedLine {
  ts: string;
  text: string;
}

export const SERIAL_LINE_SUFFIX: Record<SerialLineEnding, string> = {
  lf: "\n",
  crlf: "\r\n",
  cr: "\r",
  none: "",
};

const HEX_ROW_LENGTH = 16;
const MAX_HEX_ROWS = 4096;
const HEX_BYTES = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0").toUpperCase());

export function hexToBase64(input: string): string | null {
  const groups = input.trim().split(/\s+/);
  if (groups.some((group) => group.length % 2 || /[^0-9a-f]/i.test(group))) return null;
  const hex = groups.join("");
  const bytes = [];
  for (let offset = 0; offset < hex.length; offset += 2) {
    bytes.push(String.fromCharCode(Number.parseInt(hex.slice(offset, offset + 2), 16)));
  }
  return btoa(bytes.join(""));
}

export function appendHexRows(lines: BufferedLine[], bytes: Uint8Array, timestamp: string): BufferedLine[] {
  if (!bytes.length) return lines;
  let offset = 0;
  const next = lines.slice();
  const last = next[next.length - 1];
  const columns = last ? (last.text.length + 1) / 3 : 0;
  if (last && columns < HEX_ROW_LENGTH) {
    const count = Math.min(bytes.length, HEX_ROW_LENGTH - columns);
    const values = Array.from(bytes.subarray(0, count), (byte) => HEX_BYTES[byte]);
    next[next.length - 1] = { ...last, text: `${last.text} ${values.join(" ")}` };
    offset = count;
  }
  for (; offset < bytes.length; offset += HEX_ROW_LENGTH) {
    const values = Array.from(bytes.subarray(offset, offset + HEX_ROW_LENGTH), (byte) => HEX_BYTES[byte]);
    next.push({ ts: timestamp, text: values.join(" ") });
  }
  return next.length > MAX_HEX_ROWS ? next.slice(-MAX_HEX_ROWS) : next;
}
