import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { ChevronDown, ChevronUp, Download } from "lucide-react";
import { useTranslation } from "react-i18next";

interface LogDrawerProps {
  logs: string[];
  open: boolean;
  onToggle: () => void;
  onClear: () => void;
}

export function LogDrawer({ logs, open, onToggle, onClear }: LogDrawerProps) {
  const { t } = useTranslation();

  const handleExport = async () => {
    try {
      const filePath = await save({
        defaultPath: "openixsuit-ce.log",
        filters: [{ name: "Log", extensions: ["log", "txt"] }],
      });
      if (filePath) {
        await writeTextFile(filePath, logs.join("\n"));
      }
    } catch (err) {
      console.error("导出日志失败:", err);
    }
  };

  return (
    <footer className="border-t border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center justify-between px-4 py-1.5 text-xs text-slate-500 dark:text-slate-400">
        <button onClick={onToggle} className="flex items-center gap-1.5 hover:text-slate-900 dark:hover:text-white">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
          <span>
            {t("log.live")} ({logs.length})
          </span>
        </button>
        <div className="flex items-center gap-3">
          <button onClick={handleExport} className="flex items-center gap-1 hover:text-blue-400">
            <Download className="h-3.5 w-3.5" />
            {t("log.export")}
          </button>
          <button onClick={onClear} className="hover:text-red-400">
            {t("log.clear")}
          </button>
        </div>
      </div>

      {open && (
        <div className="h-40 overflow-y-auto border-t border-slate-200 bg-slate-950 p-3 font-mono text-xs text-slate-300 dark:border-slate-800">
          {logs.length === 0 ? (
            <div className="text-slate-500">{t("log.empty")}</div>
          ) : (
            logs.map((line, i) => <div key={i}>{line}</div>)
          )}
        </div>
      )}
    </footer>
  );
}
