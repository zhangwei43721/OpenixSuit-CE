import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import { Sidebar, TabKey } from "./components/Sidebar";
import { AdbDevice, FelDevice, TopBar } from "./components/TopBar";
import { LogDrawer } from "./components/LogDrawer";
import { AppSettings, loadSettings, saveSettings, ThemeMode } from "./store/settings";
import { FlashHub } from "./pages/FlashHub";
import { EfelDebugger } from "./pages/EfelDebugger";
import { AdbExplorer } from "./pages/AdbExplorer";
import { GpioViewer } from "./pages/GpioViewer";
import { PluginRunner } from "./pages/PluginRunner";
import { SettingsPage } from "./pages/SettingsPage";
import { getExtensionTabs, PluginManifest } from "./types/plugin";

const STORAGE_ADB_SERIAL_KEY = "adb_last_serial";

function resolveTheme(mode: ThemeMode): "dark" | "light" {
  if (mode === "dark" || mode === "light") return mode;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(mode: ThemeMode): "dark" | "light" {
  const effective = resolveTheme(mode);
  document.documentElement.classList.toggle("dark", effective === "dark");
  localStorage.setItem("theme_mode", mode);
  return effective;
}

interface AiSyncEventPayload {
  source: string;
  action: string;
  status: "started" | "completed" | "error";
  message: string;
}

export default function App() {
  const { i18n } = useTranslation();
  const [activeTab, setActiveTab] = useState<TabKey>("firmware");
  const [visitedTabs, setVisitedTabs] = useState<Record<string, boolean>>({
    firmware: true,
    debugger: false,
    adb: false,
    gpio: false,
    settings: false,
  });
  const [plugins, setPlugins] = useState<PluginManifest[]>([]);
  const extensionTabs = useMemo(() => getExtensionTabs(plugins), [plugins]);

  const refreshPlugins = useCallback(async () => {
    try {
      const list = await invoke<PluginManifest[]>("list_plugins");
      setPlugins(Array.isArray(list) ? list : []);
    } catch {
      setPlugins([]);
    }
  }, []);
  const [collapsed, setCollapsed] = useState(false);
  const [isFlashing, setIsFlashing] = useState(false);
  const [aiSyncStatus, setAiSyncStatus] = useState<string | null>(null);
  const [felDevices, setFelDevices] = useState<FelDevice[]>([]);
  const [adbDevices, setAdbDevices] = useState<AdbDevice[]>([]);
  const [selectedAdbSerial, setSelectedAdbSerial] = useState(
    () => localStorage.getItem(STORAGE_ADB_SERIAL_KEY) || ""
  );
  const [logs, setLogs] = useState<string[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(() => ({
    language: "zh-CN",
    theme: (localStorage.getItem("theme_mode") as ThemeMode) || "system",
    usb_backend: "auto",
  }));
  const [effectiveTheme, setEffectiveTheme] = useState<"dark" | "light">(() =>
    resolveTheme((localStorage.getItem("theme_mode") as ThemeMode) || "system")
  );

  const appendLog = (msg: string) => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev.slice(-499), `[${time}] ${msg}`]);
  };

  const selectTab = (tab: TabKey) => {
    setActiveTab(tab);
    setVisitedTabs((prev) => (prev[tab] ? prev : { ...prev, [tab]: true }));
  };

  const refreshAllDevices = async () => {
    const [felList, adbList] = await Promise.all([
      invoke<FelDevice[]>("scan_devices").catch(() => []),
      invoke<AdbDevice[]>("adb_list_devices").catch(() => []),
    ]);
    setFelDevices(felList);
    setAdbDevices(adbList);
    if (adbList.length > 0) {
      const preferred = localStorage.getItem(STORAGE_ADB_SERIAL_KEY) || selectedAdbSerial;
      const matched = adbList.find((d) => d.serial === preferred) || adbList[0];
      setSelectedAdbSerial(matched.serial);
      localStorage.setItem(STORAGE_ADB_SERIAL_KEY, matched.serial);
    } else {
      setSelectedAdbSerial("");
    }
  };

  useEffect(() => {
    setEffectiveTheme(applyTheme(settings.theme));
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemChange = () => {
      if (settings.theme === "system") {
        setEffectiveTheme(applyTheme("system"));
      }
    };
    mq.addEventListener("change", onSystemChange);
    return () => mq.removeEventListener("change", onSystemChange);
  }, [settings.theme]);

  useEffect(() => {
    let shown = false;
    const showWin = () => {
      if (shown) return;
      shown = true;
      getCurrentWindow().show().catch(() => {});
    };
    const fallbackTimer = setTimeout(showWin, 250);

    loadSettings()
      .then((loaded) => {
        setSettings(loaded);
        i18n.changeLanguage(loaded.language);
        setEffectiveTheme(applyTheme(loaded.theme));
      })
      .catch(() => {})
      .finally(() => {
        requestAnimationFrame(showWin);
      });

    const initScanTimer = setTimeout(() => {
      refreshAllDevices();
      refreshPlugins();
    }, 50);

    const unlisten = listen<{ connected: boolean; count: number }>("usb-hotplug", (event) => {
      appendLog(
        `USB 热插拔事件: ${event.payload.connected ? "connected" : "disconnected"} (${event.payload.count})`
      );
      refreshAllDevices();
    });

    const unlistenAiSync = listen<AiSyncEventPayload>("ai-sync-event", (event) => {
      const { action, status, message } = event.payload;
      appendLog(`[AI] ${action}: ${message}`);
      if (status === "started") {
        setAiSyncStatus(action);
        if (action === "flash" || action === "raw") {
          setIsFlashing(true);
        }
      } else if (status === "completed" || status === "error") {
        setAiSyncStatus(null);
        if (action === "flash" || action === "raw") {
          setIsFlashing(false);
        }
        if (
          status === "completed" &&
          (action === "plugin-install" || action === "plugin-uninstall")
        ) {
          refreshPlugins();
        }
      }
    });

    const adbTimer = setInterval(() => {
      invoke<AdbDevice[]>("adb_list_devices")
        .then((adbList) => {
          setAdbDevices(adbList);
          if (adbList.length > 0) {
            const preferred = localStorage.getItem(STORAGE_ADB_SERIAL_KEY) || "";
            const matched = adbList.find((d) => d.serial === preferred) || adbList[0];
            setSelectedAdbSerial((cur) => (cur === matched.serial ? cur : matched.serial));
            localStorage.setItem(STORAGE_ADB_SERIAL_KEY, matched.serial);
          } else {
            setSelectedAdbSerial("");
          }
        })
        .catch(() => {
          setAdbDevices([]);
          setSelectedAdbSerial("");
        });
    }, 3000);

    return () => {
      clearTimeout(fallbackTimer);
      clearTimeout(initScanTimer);
      clearInterval(adbTimer);
      unlisten.then((fn) => fn());
      unlistenAiSync.then((fn) => fn());
    };
  }, [i18n, refreshPlugins]);

  useEffect(() => {
    if (
      activeTab.startsWith("ext:") &&
      !extensionTabs.some((ext) => ext.key === activeTab)
    ) {
      setActiveTab("firmware");
    }
  }, [activeTab, extensionTabs]);

  const handleSelectAdbSerial = (next: string) => {
    setSelectedAdbSerial(next);
    localStorage.setItem(STORAGE_ADB_SERIAL_KEY, next);
  };

  const handleAdbRoot = async () => {
    if (!selectedAdbSerial) return;
    try {
      const res = await invoke<string>("adb_root", { serial: selectedAdbSerial });
      appendLog(`[${selectedAdbSerial}] adb root: ${res || "OK"}`);
      await refreshAllDevices();
    } catch (err) {
      appendLog(`adb root 失败: ${String(err)}`);
    }
  };

  const handleAdbReboot = async () => {
    if (!selectedAdbSerial) return;
    try {
      await invoke("adb_reboot", { serial: selectedAdbSerial });
      appendLog(`[${selectedAdbSerial}] 已发送重启指令`);
      setTimeout(refreshAllDevices, 2500);
    } catch (err) {
      appendLog(`重启设备失败: ${String(err)}`);
    }
  };

  const handleSwitchEfex = async () => {
    if (!selectedAdbSerial) return;
    try {
      const res = await invoke<string>("adb_reboot_efex", { serial: selectedAdbSerial });
      appendLog(res || `已发送重启进入烧录模式指令 -> ${selectedAdbSerial}`);
      setTimeout(refreshAllDevices, 2500);
    } catch (err) {
      appendLog(`切换烧录模式失败: ${String(err)}`);
    }
  };

  const updateSettings = async (patch: Partial<AppSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    if (patch.language) i18n.changeLanguage(patch.language);
    if (patch.theme) setEffectiveTheme(applyTheme(patch.theme));
    if (patch.usb_backend) {
      try {
        await invoke("set_usb_backend", { backend: patch.usb_backend });
        appendLog(`切换 USB 后端为: ${patch.usb_backend}`);
      } catch (err) {
        appendLog(`切换 USB 后端失败: ${String(err)}`);
      }
    }
    await saveSettings(next).catch(() => {});
  };

  return (
    <div className="flex h-screen flex-col bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <TopBar
        felDevices={felDevices}
        adbDevices={adbDevices}
        selectedAdbSerial={selectedAdbSerial}
        aiSyncStatus={aiSyncStatus}
        onSelectAdbSerial={handleSelectAdbSerial}
        onRefreshDevices={refreshAllDevices}
        onAdbRoot={handleAdbRoot}
        onAdbReboot={handleAdbReboot}
        onSwitchEfex={handleSwitchEfex}
      />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          activeTab={activeTab}
          collapsed={collapsed}
          locked={isFlashing}
          extensionTabs={extensionTabs}
          onSelect={selectTab}
          onToggleCollapse={() => setCollapsed((c) => !c)}
        />
        <main className="flex-1 overflow-auto p-5">
          {visitedTabs.firmware && (
            <div className={activeTab === "firmware" ? "h-full" : "hidden"}>
              <FlashHub
                isFlashing={isFlashing}
                onFlashingChange={setIsFlashing}
                onLog={appendLog}
              />
            </div>
          )}
          {visitedTabs.debugger && (
            <div className={activeTab === "debugger" ? "h-full" : "hidden"}>
              <EfelDebugger theme={effectiveTheme} onLog={appendLog} />
            </div>
          )}
          {visitedTabs.adb && (
            <div className={activeTab === "adb" ? "h-full" : "hidden"}>
              <AdbExplorer serial={selectedAdbSerial} theme={effectiveTheme} onLog={appendLog} />
            </div>
          )}
          {visitedTabs.gpio && (
            <div className={activeTab === "gpio" ? "h-full" : "hidden"}>
              <GpioViewer
                serial={selectedAdbSerial}
                felConnected={felDevices.length > 0}
                onLog={appendLog}
              />
            </div>
          )}
          {extensionTabs.map((ext) =>
            visitedTabs[ext.key] ? (
              <div key={ext.key} className={activeTab === ext.key ? "h-full" : "hidden"}>
                <PluginRunner item={ext} serial={selectedAdbSerial} onLog={appendLog} />
              </div>
            ) : null
          )}
          {visitedTabs.settings && (
            <div className={activeTab === "settings" ? "h-full" : "hidden"}>
              <SettingsPage
                settings={settings}
                plugins={plugins}
                onUpdate={updateSettings}
                onRefreshPlugins={refreshPlugins}
                onLog={appendLog}
              />
            </div>
          )}
        </main>
      </div>

      <LogDrawer
        logs={logs}
        open={logOpen}
        onToggle={() => setLogOpen((o) => !o)}
        onClear={() => setLogs([])}
      />
    </div>
  );
}
