import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import { getFirstSidebarTab, Sidebar, TabKey } from "./components/Sidebar";
import { AdbDevice, adbDeviceKey, adbDeviceLabel, efexDeviceLabel, adbDeviceOnline, adbSerialAmbiguous, resolveAdbDevice, FelDevice, TopBar } from "./components/TopBar";
import { LogDrawer } from "./components/LogDrawer";
import { AppSettings, loadSettings, saveSettings, ThemeMode } from "./store/settings";
import { FlashHub } from "./pages/FlashHub";
import { SerialPage } from "./pages/SerialPage";
import { EfelDebugger } from "./pages/EfelDebugger";
import { AdbExplorer } from "./pages/AdbExplorer";
import { AdbTerminalPage } from "./pages/AdbTerminalPage";
import { DeviceMonitorPage } from "./pages/DeviceMonitorPage";
import { AdbScreenPage } from "./pages/AdbScreenPage";
import { GpioViewer } from "./pages/GpioViewer";
import { AutomationPage } from "./pages/AutomationPage";
import { AiWorkbenchPage } from "./pages/AiWorkbenchPage";
import { PluginRunner } from "./pages/PluginRunner";
import { SettingsPage } from "./pages/SettingsPage";
import { WorkspaceModal } from "./components/WorkspaceModal";
import { getExtensionTabs, PluginManifest } from "./types/plugin";
import { DeviceWorkspace } from "./types/workbench";

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
  const [activeTab, setActiveTab] = useState<TabKey>(() => getFirstSidebarTab());
  const [visitedTabs, setVisitedTabs] = useState<Record<string, boolean>>(() => ({
    firmware: false,
    serial: false,
    debugger: false,
    adb: false,
    "adb-term": false,
    monitor: false,
    screen: false,
    gpio: false,
    automation: false,
    ai: false,
    settings: false,
    [activeTab]: true,
  }));
  const [plugins, setPlugins] = useState<PluginManifest[]>([]);
  const extensionTabs = useMemo(() => getExtensionTabs(plugins), [plugins]);
  const [workspaces, setWorkspaces] = useState<DeviceWorkspace[]>([]);
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(
    () => localStorage.getItem("active_workspace_id") || null
  );
  const [workspaceModal, setWorkspaceModal] = useState<{
    open: boolean;
    editing: DeviceWorkspace | null;
  }>({ open: false, editing: null });
  const [syncEvents, setSyncEvents] = useState<
    Array<{ time: string; source: string; action: string; status: string; message: string }>
  >([]);
  const [adbJumpRequest, setAdbJumpRequest] = useState<{ path: string; seq: number } | null>(null);

  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeWorkspaceId) || null,
    [workspaces, activeWorkspaceId]
  );

  const refreshWorkspaces = useCallback(async () => {
    try {
      const list = await invoke<DeviceWorkspace[]>("workspace_list");
      setWorkspaces(Array.isArray(list) ? list : []);
    } catch {
      setWorkspaces([]);
    } finally {
      setWorkspacesLoaded(true);
    }
  }, []);

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
  const [switchingEfex, setSwitchingEfex] = useState(false);
  const [efexSwitchNotice, setEfexSwitchNotice] = useState<{ text: string; failed?: boolean } | null>(null);
  const [aiSyncStatus, setAiSyncStatus] = useState<string | null>(null);
  const [felDevices, setFelDevices] = useState<FelDevice[]>([]);
  const [adbDevices, setAdbDevices] = useState<AdbDevice[]>([]);
  const [preferredAdbTarget, setPreferredAdbTarget] = useState(
    () => localStorage.getItem(STORAGE_ADB_SERIAL_KEY) || ""
  );
  const adbNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const workspace of workspaces) {
      const device = resolveAdbDevice(workspace.adb_serial, adbDevices);
      if (device && workspace.name) names.set(adbDeviceKey(device), workspace.name);
    }
    return names;
  }, [workspaces, adbDevices]);
  const selectedAdbDevice = resolveAdbDevice(preferredAdbTarget, adbDevices);
  const selectedAdbTarget = selectedAdbDevice ? adbDeviceKey(selectedAdbDevice) : "";
  const selectedAdbSerial = adbDeviceOnline(selectedAdbDevice) ? selectedAdbTarget : "";
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

  const appendLog = useCallback((msg: string) => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev.slice(-499), `[${time}] ${msg}`]);
  }, []);

  const selectTab = (tab: TabKey) => {
    setActiveTab(tab);
    setVisitedTabs((prev) => (prev[tab] ? prev : { ...prev, [tab]: true }));
  };

  const applyAdbDevices = useCallback((devices: AdbDevice[]) => {
    setAdbDevices(devices);
    const saved = localStorage.getItem(STORAGE_ADB_SERIAL_KEY) || "";
    const device = saved ? resolveAdbDevice(saved, devices) : devices.length === 1 ? devices[0] : undefined;
    // 旧配置遇到重复序列号后要求重新选择，避免拔掉一块板时误绑定剩下的板。
    const preferred = adbSerialAmbiguous(saved, devices) ? `adb-ambiguous:${saved}` : device ? adbDeviceKey(device) : saved;
    if (preferred !== saved) localStorage.setItem(STORAGE_ADB_SERIAL_KEY, preferred);
    setPreferredAdbTarget(preferred);
  }, []);

  const refreshAllDevices = async () => {
    const [felList, adbList] = await Promise.all([
      invoke<FelDevice[]>("scan_devices").catch(() => []),
      invoke<AdbDevice[]>("adb_list_devices").catch(() => []),
    ]);
    setFelDevices(felList);
    applyAdbDevices(adbList);
    return { felList, adbList };
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
      refreshWorkspaces();
    }, 50);

    const unlisten = listen<{ connected: boolean; count: number }>("usb-hotplug", (event) => {
      appendLog(
        `USB 热插拔事件: ${event.payload.connected ? "connected" : "disconnected"} (${event.payload.count})`
      );
      refreshAllDevices();
    });

    const unlistenAiSync = listen<AiSyncEventPayload>("ai-sync-event", (event) => {
      const { source, action, status, message } = event.payload;
      appendLog(`[AI] ${action}: ${message}`);
      setSyncEvents((prev) => [
        ...prev.slice(-199),
        {
          time: new Date().toLocaleTimeString(),
          source,
          action,
          status,
          message,
        },
      ]);
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

    const unlistenFlashLog = listen<{ stage: string; level: string; message: string }>(
      "flash-log",
      (event) => {
        if (event.payload?.message) {
          const warnTag = event.payload.level === "warn" ? "[WARN] " : "";
          appendLog(`[${event.payload.stage || "FLASH"}] ${warnTag}${event.payload.message}`);
        }
      }
    );

    const adbTimer = setInterval(() => {
      invoke<AdbDevice[]>("adb_list_devices")
        .then(applyAdbDevices)
        .catch(() => applyAdbDevices([]));
    }, 3000);

    return () => {
      clearTimeout(fallbackTimer);
      clearTimeout(initScanTimer);
      clearInterval(adbTimer);
      unlisten.then((fn) => fn());
      unlistenAiSync.then((fn) => fn());
      unlistenFlashLog.then((fn) => fn());
    };
  }, [i18n, refreshPlugins, refreshWorkspaces, appendLog, applyAdbDevices]);

  useEffect(() => {
    if (
      activeTab.startsWith("ext:") &&
      !extensionTabs.some((ext) => ext.key === activeTab)
    ) {
      setActiveTab("firmware");
    }
  }, [activeTab, extensionTabs]);

  const handleSelectAdbSerial = (next: string) => {
    const device = resolveAdbDevice(next, adbDevices);
    const target = adbSerialAmbiguous(next, adbDevices) ? `adb-ambiguous:${next}` : device ? adbDeviceKey(device) : next;
    setPreferredAdbTarget(target);
    localStorage.setItem(STORAGE_ADB_SERIAL_KEY, target);
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
    if (!selectedAdbSerial || !selectedAdbDevice || switchingEfex || isFlashing) return;
    const label = adbDeviceLabel(selectedAdbDevice, adbNames.get(selectedAdbSerial));
    const usbPath = selectedAdbDevice.usb_path;
    setSwitchingEfex(true);
    setEfexSwitchNotice({ text: i18n.t("status.waitEfexTarget", { label }) });
    try {
      const res = await invoke<string>("adb_reboot_efex", { serial: selectedAdbSerial });
      appendLog(res);
      if (!usbPath || !/^usb:\d+-\d+(?:\.\d+)*$/.test(usbPath)) {
        setEfexSwitchNotice({ text: i18n.t("status.unverifiedEfexTarget", { label }) });
        await refreshAllDevices();
        return;
      }
      for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        const { felList } = await refreshAllDevices();
        const match = felList.find((device) => device.usb_path === usbPath);
        if (match && (match.mode.startsWith("FEL (") || match.mode.startsWith("FES ("))) {
          setEfexSwitchNotice({ text: i18n.t("status.verifiedEfexTarget", { label, device: efexDeviceLabel(match) }) });
          return;
        }
      }
      setEfexSwitchNotice({ text: i18n.t("status.efexTargetTimeout", { label }), failed: true });
    } catch (error) {
      const text = i18n.t("status.efexTargetFailed", { label, error: String(error) });
      appendLog(text);
      setEfexSwitchNotice({ text, failed: true });
    } finally {
      setSwitchingEfex(false);
    }
  };

  const handleExitFes = async (deviceId: string, action: "reboot" | "fel") => {
    if (isFlashing || switchingEfex) {
      throw new Error(i18n.t("fesExit.busy"));
    }
    const matchingDevices = felDevices.filter((device) => device.id === deviceId);
    if (matchingDevices.length !== 1 || matchingDevices[0].mode !== "FES (U-Boot)") {
      throw new Error(i18n.t("fesExit.deviceUnavailable"));
    }

    try {
      await invoke<void>("fes_exit", { deviceId, action });
      const message = i18n.t(action === "reboot" ? "fesExit.rebootSent" : "fesExit.felSent");
      appendLog(`[${deviceId}] ${message}`);
      await refreshAllDevices();
    } catch (error) {
      appendLog(`[${deviceId}] ${i18n.t("fesExit.failed", { error: String(error) })}`);
      throw error;
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

  const handleSelectWorkspace = (id: string | null) => {
    setActiveWorkspaceId(id);
    if (id) {
      localStorage.setItem("active_workspace_id", id);
      const ws = workspaces.find((w) => w.id === id);
      if (ws?.adb_serial) {
        handleSelectAdbSerial(ws.adb_serial);
      }
    } else {
      localStorage.removeItem("active_workspace_id");
    }
  };

  const handleSaveWorkspace = async (ws: DeviceWorkspace) => {
    const exists = workspaces.some((w) => w.id === ws.id);
    const next = exists
      ? workspaces.map((w) => (w.id === ws.id ? ws : w))
      : [...workspaces, ws];
    await invoke("workspace_save", { workspaces: next });
    setWorkspaces(next);
    handleSelectWorkspace(ws.id);
  };

  const handleDeleteWorkspace = async (id: string) => {
    const next = workspaces.filter((w) => w.id !== id);
    await invoke("workspace_save", { workspaces: next });
    setWorkspaces(next);
    if (activeWorkspaceId === id) {
      handleSelectWorkspace(null);
    }
  };

  return (
    <div className="flex h-screen flex-col bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <TopBar
        felDevices={felDevices}
        adbDevices={adbDevices}
        selectedAdbTarget={selectedAdbTarget}
        adbNames={adbNames}
        unavailableAdbTarget={!!preferredAdbTarget && !selectedAdbDevice}
        aiSyncStatus={aiSyncStatus}
        switchingEfex={switchingEfex}
        deviceActionBusy={isFlashing}
        onSelectAdbSerial={handleSelectAdbSerial}
        onRefreshDevices={refreshAllDevices}
        onAdbRoot={handleAdbRoot}
        onAdbReboot={handleAdbReboot}
        onSwitchEfex={handleSwitchEfex}
        onExitFes={handleExitFes}
      />
      {efexSwitchNotice && (
        <div role={efexSwitchNotice.failed ? "alert" : "status"}
          className={`flex items-center justify-between gap-3 border-b px-4 py-1.5 text-xs ${efexSwitchNotice.failed ? "text-rose-700 dark:text-rose-300" : "text-slate-700 dark:text-slate-200"}`}>
          <span>{efexSwitchNotice.text}</span>
          {!switchingEfex && <button type="button" className="ui-btn-secondary py-1" onClick={() => setEfexSwitchNotice(null)}>
            {i18n.t("common.close")}
          </button>}
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          activeTab={activeTab}
          collapsed={collapsed}
          locked={isFlashing}
          extensionTabs={extensionTabs}
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          onSelectWorkspace={handleSelectWorkspace}
          onAddWorkspace={() => setWorkspaceModal({ open: true, editing: null })}
          onEditWorkspace={(ws) => setWorkspaceModal({ open: true, editing: ws })}
          onDeleteWorkspace={handleDeleteWorkspace}
          onSelect={selectTab}
          onToggleCollapse={() => setCollapsed((c) => !c)}
        />
        <main className="flex-1 overflow-auto bg-slate-50/80 p-5 dark:bg-slate-950">
          {visitedTabs.firmware && (
            <div className={activeTab === "firmware" ? "h-full" : "hidden"}>
              <FlashHub
                felDevices={felDevices}
                isFlashing={isFlashing}
                onFlashingChange={setIsFlashing}
                onLog={appendLog}
              />
            </div>
          )}
          {(visitedTabs.serial || workspacesLoaded) && (
            <div className={activeTab === "serial" ? "h-full" : "hidden"}>
              <SerialPage
                activeWorkspace={activeWorkspace}
                adbDevices={adbDevices}
                selectedAdbSerial={selectedAdbSerial}
                onRefreshDevices={refreshAllDevices}
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
              <AdbExplorer
                key={selectedAdbSerial}
                serial={selectedAdbSerial}
                theme={effectiveTheme}
                jumpRequest={adbJumpRequest}
                onLog={appendLog}
              />
            </div>
          )}
          {visitedTabs["adb-term"] && (
            <div className={activeTab === "adb-term" ? "h-full" : "hidden"}>
              <AdbTerminalPage serial={selectedAdbSerial} onLog={appendLog} />
            </div>
          )}
          {visitedTabs.monitor && (
            <div className={activeTab === "monitor" ? "h-full" : "hidden"}>
              <DeviceMonitorPage
                key={selectedAdbSerial}
                serial={selectedAdbSerial}
                onLog={appendLog}
                onNavigateAdbPath={(remotePath) => {
                  setAdbJumpRequest({ path: remotePath, seq: Date.now() });
                  selectTab("adb");
                }}
              />
            </div>
          )}
          {visitedTabs.screen && (
            <div className={activeTab === "screen" ? "h-full" : "hidden"}>
              <AdbScreenPage key={selectedAdbSerial} serial={selectedAdbSerial} onLog={appendLog} />
            </div>
          )}
          {visitedTabs.gpio && (
            <div className={activeTab === "gpio" ? "h-full" : "hidden"}>
              <GpioViewer
                key={selectedAdbSerial}
                serial={selectedAdbSerial}
                adbLabel={selectedAdbDevice ? adbDeviceLabel(selectedAdbDevice, adbNames.get(selectedAdbSerial)) : selectedAdbSerial}
                felDevices={felDevices}
                onLog={appendLog}
              />
            </div>
          )}
          {visitedTabs.automation && (
            <div className={activeTab === "automation" ? "h-full" : "hidden"}>
              <AutomationPage onLog={appendLog} />
            </div>
          )}
          {visitedTabs.ai && (
            <div className={activeTab === "ai" ? "h-full" : "hidden"}>
              <AiWorkbenchPage syncEvents={syncEvents} onLog={appendLog} />
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

      {workspaceModal.open && (
        <WorkspaceModal
          initial={workspaceModal.editing}
          adbDevices={adbDevices}
          onClose={() => setWorkspaceModal({ open: false, editing: null })}
          onSave={handleSaveWorkspace}
        />
      )}

      <LogDrawer
        logs={logs}
        open={logOpen}
        onToggle={() => setLogOpen((o) => !o)}
        onClear={() => setLogs([])}
      />
    </div>
  );
}
