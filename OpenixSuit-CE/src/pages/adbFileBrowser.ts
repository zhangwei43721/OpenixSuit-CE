import type { AdbDetailedFileEntry } from "../types/workbench";

export type FileSort = "name" | "size" | "time";

const SIZE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];

export function formatFileSize(bytes: number, locale: string) {
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < SIZE_UNITS.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toLocaleString(locale, { maximumFractionDigits: unit === 0 ? 0 : 2 })} ${SIZE_UNITS[unit]}`;
}

export function matchesFilename(name: string, search: string) {
  return name.toLowerCase().includes(search.trim().toLowerCase());
}

function modifiedTime(value: string, now: Date) {
  const withYear = /^([A-Za-z]{3}\s+\d{1,2})\s+(\d{1,2}:\d{2})$/.exec(value);
  if (!withYear) return Date.parse(value.replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T"));
  const [, day, time] = withYear;
  const year = now.getFullYear();
  const thisYear = Date.parse(`${day} ${year} ${time}`);
  return thisYear > now.getTime() ? Date.parse(`${day} ${year - 1} ${time}`) : thisYear;
}

export function sortFiles(entries: AdbDetailedFileEntry[], sort: FileSort, descending: boolean, locale: string) {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  const now = new Date();
  const dates = sort === "time" ? new Map(entries.map((entry) => [entry.name, modifiedTime(entry.modified_time, now)])) : null;
  const direction = descending ? -1 : 1;
  return [...entries].sort((left, right) => {
    if (left.is_dir !== right.is_dir) return left.is_dir ? -1 : 1;
    const byName = collator.compare(left.name, right.name) || (left.name < right.name ? -1 : Number(left.name > right.name));
    if (sort === "size") return left.is_dir ? byName : direction * (left.size - right.size) || byName;
    if (dates) {
      const l = dates.get(left.name) ?? NaN;
      const r = dates.get(right.name) ?? NaN;
      if (Number.isNaN(l) !== Number.isNaN(r)) return Number(Number.isNaN(l)) - Number(Number.isNaN(r));
      return direction * (l - r) || byName;
    }
    return direction * byName;
  });
}
