use crate::state::{epoch_ms, AppState};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum LogUiAction {
    Get,
    PaneSet,
    LayoutSet,
    BridgeSet,
    HighlightSet,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LogUiRequest {
    pub action: LogUiAction,
    #[serde(default)]
    pub params: Map<String, Value>,
}

#[derive(Serialize, Clone)]
struct RequestEvent {
    id: String,
    action: LogUiAction,
    params: Map<String, Value>,
}

type Reply = Result<Value, String>;

#[derive(Default)]
pub(crate) struct LogUiBroker {
    sequence: AtomicU64,
    replies: Mutex<HashMap<String, oneshot::Sender<Reply>>>,
}

// 请求取消、发布失败和超时都通过同一处释放等待项。
struct PendingRequest<'a> {
    broker: &'a LogUiBroker,
    id: String,
}

impl Drop for PendingRequest<'_> {
    fn drop(&mut self) {
        if let Ok(mut replies) = self.broker.replies.lock() {
            replies.remove(&self.id);
        }
    }
}

impl LogUiBroker {
    fn begin(&self) -> Result<(PendingRequest<'_>, oneshot::Receiver<Reply>), String> {
        let id = format!(
            "{}-{}",
            epoch_ms(),
            self.sequence.fetch_add(1, Ordering::Relaxed)
        );
        let mut replies = self.replies.lock().map_err(|_| "Log UI state is unavailable".to_string())?;
        if replies.len() >= 32 {
            return Err("Too many pending log UI requests".to_string());
        }
        let (send, receive) = oneshot::channel();
        replies.insert(id.clone(), send);
        Ok((PendingRequest { broker: self, id }, receive))
    }

    fn complete(&self, id: &str, reply: Reply) -> Result<(), String> {
        let sender = self.replies.lock().map_err(|_| "Log UI state is unavailable".to_string())?.remove(id);
        // 页面重载后可能收到已结束请求的响应，旧响应直接丢弃。
        if let Some(sender) = sender {
            let _ = sender.send(reply);
        }
        Ok(())
    }

    pub(crate) async fn request(&self, app: &AppHandle, request: LogUiRequest) -> Reply {
        let (pending, receiver) = self.begin()?;
        app.emit_to("main", "log-ui-request", RequestEvent {
            id: pending.id.clone(),
            action: request.action,
            params: request.params,
        }).map_err(|error| format!("Failed to send log settings to the desktop: {error}"))?;
        tokio::time::timeout(Duration::from_secs(5), receiver)
            .await
            .map_err(|_| "The desktop did not acknowledge the log settings request".to_string())?
            .map_err(|_| "The desktop closed the log settings request".to_string())?
    }
}

#[tauri::command]
pub(crate) fn log_ui_reply(
    state: State<'_, AppState>,
    id: String,
    value: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    let reply = match error {
        Some(error) => Err(error),
        None => value.ok_or_else(|| "The desktop returned no log settings".to_string()),
    };
    state.log_ui.complete(&id, reply)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn replies_are_routed_once_and_canceled_requests_are_removed() {
        let broker = LogUiBroker::default();
        let (first, first_reply) = broker.begin().unwrap();
        let (second, mut second_reply) = broker.begin().unwrap();
        assert_ne!(first.id, second.id);
        broker.complete(&first.id, Ok(json!({"saved": true}))).unwrap();
        broker.complete(&first.id, Err("duplicate".into())).unwrap();
        assert_eq!(first_reply.await.unwrap().unwrap(), json!({"saved": true}));
        assert!(second_reply.try_recv().is_err());
        let canceled_id = second.id.clone();
        drop(second);
        assert!(second_reply.await.is_err());
        broker.complete(&canceled_id, Ok(json!({}))).unwrap();
        assert!(broker.replies.lock().unwrap().is_empty());
    }
}
