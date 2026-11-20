import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

export type AdbLogStream = "stdout" | "stderr";

interface AdbLogData {
  session_id: string;
  timestamp: string;
  data_base64: string;
  stream?: AdbLogStream;
}

interface AdbLogEnded {
  session_id: string;
}

export function useAdbLogOutput(
  onChunk: (id: string, text: string, timestamp: string, stream: AdbLogStream) => void
) {
  const sessions = useRef(new Map<string, Record<AdbLogStream, TextDecoder>>());
  const [ready, setReady] = useState(false);
  const [listenerError, setListenerError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const activeSessions = sessions.current;
    const dataListener = listen<AdbLogData>("adb-log-data", ({ payload }) => {
      if (!mounted) return;
      let decoders = activeSessions.get(payload.session_id);
      if (!decoders) {
        decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
        activeSessions.set(payload.session_id, decoders);
      }
      const stream = payload.stream === "stderr" ? "stderr" : "stdout";
      const bytes = Uint8Array.from(atob(payload.data_base64), (char) => char.charCodeAt(0));
      const text = decoders[stream].decode(bytes, { stream: true });
      if (text) onChunk(payload.session_id, text, payload.timestamp, stream);
    });
    const endListener = listen<AdbLogEnded>("adb-log-ended", ({ payload }) => {
      if (!mounted) return;
      const decoders = activeSessions.get(payload.session_id);
      activeSessions.delete(payload.session_id);
      for (const stream of ["stdout", "stderr"] as const) {
        const tail = decoders?.[stream].decode();
        if (tail) onChunk(payload.session_id, tail, "", stream);
      }
    });
    Promise.all([dataListener, endListener]).then(
      () => { if (mounted) setReady(true); },
      (error) => { if (mounted) setListenerError(String(error)); }
    );
    return () => {
      mounted = false;
      for (const listener of [dataListener, endListener]) {
        void listener.then((unlisten) => unlisten()).catch(() => {});
      }
      activeSessions.clear();
    };
  }, [onChunk]);

  return {
    ready,
    listenerError,
    forget: (id: string) => sessions.current.delete(id),
  };
}
