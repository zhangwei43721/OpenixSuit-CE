import { useEffect, useMemo, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeFile } from "@tauri-apps/plugin-fs";
import { Download, FolderOpen, Plus, RotateCcw, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  formatGpioPortValue,
  parseGpioPortValue,
  parseSysConfig,
  serializeSysConfig,
  SysConfigDoc,
} from "../utils/sysConfig";

interface SysConfigEditorProps {
  rawText: string;
  onLog: (msg: string) => void;
}

export function SysConfigEditor({ rawText, onLog }: SysConfigEditorProps) {
  const { t } = useTranslation();
  const [sourceText, setSourceText] = useState(rawText);
  const [doc, setDoc] = useState<SysConfigDoc>(() => parseSysConfig(rawText));
  const [activeSection, setActiveSection] = useState<string>("__all__");
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<"visual" | "raw">("visual");
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    setSourceText(rawText);
    const parsed = parseSysConfig(rawText);
    setDoc(parsed);
    setActiveSection(parsed.sections[0] || "__all__");
    setErrorMsg(null);
  }, [rawText]);

  const modifiedCount = useMemo(
    () => doc.entries.filter((e) => e.value !== e.originalValue || e.lineIndex < 0).length,
    [doc.entries]
  );

  const sectionCounts = useMemo(() => {
    const counts = new Map<string, { total: number; modified: number }>();
    for (const sec of doc.sections) {
      counts.set(sec, { total: 0, modified: 0 });
    }
    for (const entry of doc.entries) {
      const cur = counts.get(entry.section) || { total: 0, modified: 0 };
      cur.total += 1;
      if (entry.value !== entry.originalValue || entry.lineIndex < 0) cur.modified += 1;
      counts.set(entry.section, cur);
    }
    return counts;
  }, [doc]);

  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return doc.entries.filter((e) => {
      if (activeSection !== "__all__" && e.section !== activeSection) return false;
      if (!q) return true;
      return (
        e.section.toLowerCase().includes(q) ||
        e.key.toLowerCase().includes(q) ||
        e.value.toLowerCase().includes(q) ||
        e.comment.toLowerCase().includes(q)
      );
    });
  }, [doc.entries, activeSection, query]);

  const serializedPreview = useMemo(() => serializeSysConfig(doc), [doc]);

  const updateEntryValue = (id: string, value: string) => {
    setDoc((prev) => ({
      ...prev,
      entries: prev.entries.map((e) => (e.id === id ? { ...e, value } : e)),
    }));
  };

  const resetEntry = (id: string) => {
    setDoc((prev) => ({
      ...prev,
      entries: prev.entries.map((e) => (e.id === id ? { ...e, value: e.originalValue } : e)),
    }));
  };

  const resetAll = () => {
    setDoc(parseSysConfig(sourceText));
  };

  const addEntry = () => {
    const key = newKey.trim();
    if (!key) return;
    const section = activeSection === "__all__" ? doc.sections[0] || "product" : activeSection;
    const id = `cfg-new-${Date.now()}`;
    setDoc((prev) => ({
      ...prev,
      sections: prev.sections.includes(section) ? prev.sections : [...prev.sections, section],
      entries: [
        ...prev.entries,
        {
          id,
          section,
          key,
          value: newValue.trim(),
          originalValue: "",
          comment: "",
          lineIndex: -1,
        },
      ],
    }));
    setNewKey("");
    setNewValue("");
  };

  const handleOpenExternal = async () => {
    setErrorMsg(null);
    try {
      const file = await open({
        filters: [{ name: "Allwinner Config", extensions: ["fex", "ini", "cfg", "txt"] }],
      });
      if (typeof file !== "string") return;
      const content = await readTextFile(file);
      setSourceText(content);
      const parsed = parseSysConfig(content);
      setDoc(parsed);
      setActiveSection(parsed.sections[0] || "__all__");
      onLog(`已加载外部配置文件: ${file} (${parsed.entries.length} 项)`);
    } catch (err) {
      const msg = String(err);
      setErrorMsg(msg);
      onLog(msg);
    }
  };

  const handleExport = async () => {
    setErrorMsg(null);
    try {
      const outPath = await save({
        defaultPath: "sys_config.fex",
        filters: [{ name: "FEX Config", extensions: ["fex", "ini"] }],
      });
      if (!outPath) return;
      await writeFile(outPath, new TextEncoder().encode(serializedPreview));
      onLog(`已导出 sys_config 配置 -> ${outPath}`);
    } catch (err) {
      const msg = String(err);
      setErrorMsg(msg);
      onLog(msg);
    }
  };

  return (
    <div className="space-y-2.5 rounded border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-blue-500">{t("parser.sysConfig")}</span>
          <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {doc.sections.length} sections / {doc.entries.length} keys
          </span>
          {modifiedCount > 0 && (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
              {t("parser.modifiedCount", { count: modifiedCount })}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1.5 h-3.5 w-3.5 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("parser.searchConfig")}
              className="w-44 rounded border border-slate-300 bg-white py-1 pl-7 pr-2 text-xs dark:border-slate-700 dark:bg-slate-950"
            />
          </div>

          <div className="inline-flex overflow-hidden rounded border border-slate-300 dark:border-slate-700">
            <button
              type="button"
              onClick={() => setViewMode("visual")}
              className={`px-2.5 py-1 text-xs ${
                viewMode === "visual"
                  ? "bg-blue-600 text-white"
                  : "bg-white text-slate-700 dark:bg-slate-800 dark:text-slate-200"
              }`}
            >
              {t("parser.visualView")}
            </button>
            <button
              type="button"
              onClick={() => setViewMode("raw")}
              className={`px-2.5 py-1 text-xs ${
                viewMode === "raw"
                  ? "bg-blue-600 text-white"
                  : "bg-white text-slate-700 dark:bg-slate-800 dark:text-slate-200"
              }`}
            >
              {t("parser.rawView")}
            </button>
          </div>

          <button
            type="button"
            onClick={handleOpenExternal}
            className="flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            {t("parser.openFex")}
          </button>

          {modifiedCount > 0 && (
            <button
              type="button"
              onClick={resetAll}
              className="flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {t("parser.resetConfig")}
            </button>
          )}

          <button
            type="button"
            disabled={!doc.entries.length && !sourceText}
            onClick={handleExport}
            className="flex items-center gap-1 rounded bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" />
            {t("parser.exportFex")}
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          {errorMsg}
        </div>
      )}

      {viewMode === "raw" ? (
        <pre className="h-72 overflow-auto rounded border border-slate-200 bg-slate-900 p-3 font-mono text-[11px] text-slate-200 dark:border-slate-800 dark:bg-slate-950">
          {serializedPreview || t("parser.noSysConfig")}
        </pre>
      ) : (
        <div className="grid grid-cols-12 gap-3">
          {/* Section filter sidebar */}
          <div className="col-span-3 max-h-72 space-y-1 overflow-y-auto rounded border border-slate-200 bg-white p-1.5 dark:border-slate-800 dark:bg-slate-950">
            <button
              type="button"
              onClick={() => setActiveSection("__all__")}
              className={`flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs ${
                activeSection === "__all__"
                  ? "bg-blue-600 text-white"
                  : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              }`}
            >
              <span className="truncate">{t("parser.allSections")}</span>
              <span className="font-mono text-[10px] opacity-80">{doc.entries.length}</span>
            </button>
            {doc.sections.map((sec) => {
              const info = sectionCounts.get(sec) || { total: 0, modified: 0 };
              return (
                <button
                  key={sec}
                  type="button"
                  onClick={() => setActiveSection(sec)}
                  className={`flex w-full items-center justify-between rounded px-2 py-1 text-left font-mono text-[11px] ${
                    activeSection === sec
                      ? "bg-blue-600 text-white"
                      : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                  }`}
                >
                  <span className="truncate">[{sec}]</span>
                  <span className="flex shrink-0 items-center gap-1 text-[10px] opacity-80">
                    {info.modified > 0 && (
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                    )}
                    {info.total}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Entries table */}
          <div className="col-span-9 flex max-h-72 flex-col overflow-y-auto rounded border border-slate-200 bg-white p-2 dark:border-slate-800 dark:bg-slate-950">
            {filteredEntries.length === 0 ? (
              <div className="py-10 text-center text-xs text-slate-500">
                {doc.entries.length === 0 ? t("parser.noSysConfig") : t("parser.noMatches")}
              </div>
            ) : (
              <div className="divide-y divide-slate-200 dark:divide-slate-800">
                {filteredEntries.map((entry) => {
                  const isChanged = entry.value !== entry.originalValue || entry.lineIndex < 0;
                  const gpio = parseGpioPortValue(entry.value);
                  return (
                    <div key={entry.id} className="space-y-1 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        {activeSection === "__all__" && (
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500 dark:bg-slate-900">
                            [{entry.section}]
                          </span>
                        )}
                        <span className="min-w-[140px] font-mono text-xs font-medium text-slate-800 dark:text-slate-200">
                          {entry.key}
                        </span>

                        {gpio ? (
                          <div className="flex flex-1 flex-wrap items-center gap-1.5">
                            <input
                              value={gpio.pin}
                              onChange={(e) =>
                                updateEntryValue(
                                  entry.id,
                                  formatGpioPortValue({ ...gpio, pin: e.target.value })
                                )
                              }
                              title="GPIO Pin"
                              className={`w-16 rounded border px-2 py-0.5 font-mono text-xs ${
                                isChanged
                                  ? "border-amber-500 bg-amber-500/5"
                                  : "border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900"
                              }`}
                            />
                            <input
                              value={gpio.mux}
                              onChange={(e) =>
                                updateEntryValue(
                                  entry.id,
                                  formatGpioPortValue({ ...gpio, mux: e.target.value })
                                )
                              }
                              title="Mux"
                              placeholder="mux"
                              className="w-16 rounded border border-slate-300 bg-white px-2 py-0.5 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
                            />
                            <select
                              value={gpio.pull}
                              onChange={(e) =>
                                updateEntryValue(
                                  entry.id,
                                  formatGpioPortValue({ ...gpio, pull: e.target.value })
                                )
                              }
                              title="Pull"
                              className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs dark:border-slate-700 dark:bg-slate-900"
                            >
                              <option value="default">pull: default</option>
                              <option value="0">0: 无上下拉</option>
                              <option value="1">1: 上拉</option>
                              <option value="2">2: 下拉</option>
                            </select>
                            <select
                              value={gpio.drv}
                              onChange={(e) =>
                                updateEntryValue(
                                  entry.id,
                                  formatGpioPortValue({ ...gpio, drv: e.target.value })
                                )
                              }
                              title="Drive Level"
                              className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs dark:border-slate-700 dark:bg-slate-900"
                            >
                              <option value="default">drv: default</option>
                              <option value="0">drv: 0</option>
                              <option value="1">drv: 1</option>
                              <option value="2">drv: 2</option>
                              <option value="3">drv: 3</option>
                            </select>
                            <select
                              value={gpio.level}
                              onChange={(e) =>
                                updateEntryValue(
                                  entry.id,
                                  formatGpioPortValue({ ...gpio, level: e.target.value })
                                )
                              }
                              title="Output Level"
                              className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs dark:border-slate-700 dark:bg-slate-900"
                            >
                              <option value="default">level: default</option>
                              <option value="0">level: 0</option>
                              <option value="1">level: 1</option>
                            </select>
                          </div>
                        ) : (
                          <input
                            value={entry.value}
                            onChange={(e) => updateEntryValue(entry.id, e.target.value)}
                            className={`flex-1 rounded border px-2 py-0.5 font-mono text-xs ${
                              isChanged
                                ? "border-amber-500 bg-amber-500/5"
                                : "border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900"
                            }`}
                          />
                        )}

                        {isChanged && entry.lineIndex >= 0 && (
                          <button
                            type="button"
                            onClick={() => resetEntry(entry.id)}
                            title={t("parser.resetConfig")}
                            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                          >
                            <RotateCcw className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                      {entry.comment && (
                        <div className="pl-1 text-[10px] text-slate-400">{entry.comment}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {activeSection !== "__all__" && (
              <div className="mt-2 flex items-center gap-2 border-t border-slate-200 pt-2 dark:border-slate-800">
                <input
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  placeholder={t("parser.newKeyPlaceholder")}
                  className="w-40 rounded border border-slate-300 bg-white px-2 py-1 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
                />
                <input
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addEntry()}
                  placeholder={t("parser.newValuePlaceholder")}
                  className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 font-mono text-xs dark:border-slate-700 dark:bg-slate-900"
                />
                <button
                  type="button"
                  onClick={addEntry}
                  className="flex items-center gap-1 rounded bg-blue-600 px-2.5 py-1 text-xs text-white hover:bg-blue-500"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t("parser.addParam")}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
