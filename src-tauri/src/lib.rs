//! Состояние фонового звонка и платформенные команды (Android foreground-сервис).
//! На прочих платформах команды — no-op.

use serde_json::Value;

#[cfg(target_os = "windows")]
mod screenshare;
#[cfg(target_os = "windows")]
use screenshare::{screen_active, screen_sources, screen_start, screen_stop};

/// Проверяет, что передан корректный http/https URL.
///
/// Сеть не трогаем (reqwest не подключён): проверка чисто синтаксическая,
/// чтобы фронтенд мог валидировать адрес Go-сервера до коннекта.
#[tauri::command]
fn connect_server(url: String) -> Result<Value, String> {
    let parsed = tauri::Url::parse(&url).map_err(|e| format!("некорректный URL: {e}"))?;

    match parsed.scheme() {
        "http" | "https" => Ok(serde_json::json!({
            "ok": true,
            "url": parsed.as_str(),
            "scheme": parsed.scheme(),
            "host": parsed.host_str().unwrap_or(""),
            "port": parsed.port(),
        })),
        other => Err(format!(
            "поддерживаются только http/https, получено: {other}"
        )),
    }
}

// ---------- Android: foreground-сервис звонка ----------

/// JNI-вызов в контексте Android: подключаем текущий поток к JVM и зовём
/// статический метод CallService.
#[cfg(target_os = "android")]
fn with_android_env<F>(f: F) -> Result<(), String>
where
    F: FnOnce(&mut jni::JNIEnv, jni::objects::JObject) -> Result<(), String>,
{
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| format!("vm: {e}"))?;
    let mut guard = vm
        .attach_current_thread()
        .map_err(|e| format!("attach: {e}"))?;
    let activity = unsafe { jni::objects::JObject::from_raw(ctx.context().cast()) };
    f(&mut guard, activity)
}

/// Запустить foreground-сервис микрофона (держит процесс живым в фоне).
#[cfg(target_os = "android")]
#[tauri::command]
fn call_service_start(peer: String) -> Result<(), String> {
    use jni::objects::JValueGen;
    with_android_env(|env, ctx| {
        let jstr = env
            .new_string(peer)
            .map_err(|e| format!("new_string: {e}"))?;
        env.call_static_method(
            "dev/longhorn/messenger/CallServiceKt",
            "callServiceStart",
            "(Landroid/content/Context;Ljava/lang/String;)V",
            &[JValueGen::Object(&ctx), JValueGen::Object(&jstr)],
        )
        .map_err(|e| format!("start service: {e}"))?;
        Ok(())
    })
}

#[cfg(target_os = "android")]
#[tauri::command]
fn call_service_stop() -> Result<(), String> {
    use jni::objects::JValueGen;
    with_android_env(|env, ctx| {
        env.call_static_method(
            "dev/longhorn/messenger/CallServiceKt",
            "callServiceStop",
            "(Landroid/content/Context;)V",
            &[JValueGen::Object(&ctx)],
        )
        .map_err(|e| format!("stop service: {e}"))?;
        Ok(())
    })
}

/// no-op на остальных платформах
#[cfg(not(target_os = "android"))]
#[tauri::command]
fn call_service_start(peer: String) -> Result<(), String> {
    let _ = peer;
    Ok(())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn call_service_stop() -> Result<(), String> {
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tairi_invoke_handler())
        .run(tauri::generate_context!())
        .expect("не удалось запустить Longhorn Messenger");
}

#[cfg(target_os = "windows")]
fn tairi_invoke_handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool {
    tauri::generate_handler![
        connect_server,
        call_service_start,
        call_service_stop,
        screen_sources,
        screen_start,
        screen_stop,
        screen_active
    ]
}

#[cfg(not(target_os = "windows"))]
fn tairi_invoke_handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool {
    tauri::generate_handler![connect_server, call_service_start, call_service_stop]
}
