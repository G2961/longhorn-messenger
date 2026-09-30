//! Нативная демонстрация экрана: Windows Graphics.Capture (кадры) +
//! WASAPI loopback (системный звук). Никакого нативного Chrome-диалога —
//! источники выбираются в нашем стилизованном пикере (screen_sources).
//!
//! Кадры и звук стримятся в WebView через tauri::ipc::Channel сырыми байтами:
//!  - видео: JPEG-кадры (window-capture ImageEncoder) → JS рисует их на
//!    canvas и захватывает captureStream() → MediaStreamTrack → WebRTC;
//!  - звук: f32-чанки loopback → JS AudioWorklet → MediaStreamDestination → WebRTC.
#![cfg(target_os = "windows")]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
use windows_capture::encoder::{ImageEncoder, ImageEncoderPixelFormat, ImageFormat};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;

use tauri::ipc::{Channel, InvokeResponseBody};

/// Общее состояние шаринга (видно Rust-потокам и командам).
pub struct ScreenShareState {
    stopped: AtomicBool,
    video_ch: Channel<InvokeResponseBody>,
    audio_ch: Option<Channel<InvokeResponseBody>>,
}

impl ScreenShareState {
    pub fn new(
        video_ch: Channel<InvokeResponseBody>,
        audio_ch: Option<Channel<InvokeResponseBody>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            stopped: AtomicBool::new(false),
            video_ch,
            audio_ch,
        })
    }
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Relaxed);
    }
    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::Relaxed)
    }
}

static SHARE: std::sync::Mutex<Option<ShareHandle>> = std::sync::Mutex::new(None);

struct ShareHandle {
    state: Arc<ScreenShareState>,
    video: Option<CaptureControl<ScreenVideo, Box<dyn std::error::Error + Send + Sync>>>,
    audio: Option<std::thread::JoinHandle<()>>,
}

/// Контекст, передаваемый в захватчик кадров.
struct VideoCtx {
    jpeg: std::sync::Mutex<ImageEncoder>,
    last: std::sync::Mutex<Instant>,
    fps: u32,
    state: Arc<ScreenShareState>,
}

struct ScreenVideo {
    ctx: Arc<VideoCtx>,
}

impl GraphicsCaptureApiHandler for ScreenVideo {
    type Flags = Arc<VideoCtx>;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self { ctx: ctx.flags })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        _ctrl: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if self.ctx.state.is_stopped() {
            _ctrl.stop();
            return Ok(());
        }
        // троттлинг до нужного fps
        let min = Duration::from_secs(1) / self.ctx.fps.max(1);
        {
            let mut last = self.ctx.last.lock().unwrap();
            let now = Instant::now();
            if now.duration_since(*last) < min {
                return Ok(());
            }
            *last = now;
        }

        // Кадр → JPEG (дешёвое кодирование для 15fps)
        let (w, h) = (frame.width(), frame.height());
        let mut buf = frame.buffer()?;
        let v: Vec<u8> = buf.as_raw_buffer().iter().copied().collect();
        let jpeg = self.ctx.jpeg.lock().unwrap().encode(&v, w, h)?;
        let _ = self.ctx.state.video_ch.send(InvokeResponseBody::Raw(jpeg));
        Ok(())
    }
}

/// Список источников (мониторы + окна) для нашего стилизованного пикера.
#[tauri::command]
pub fn screen_sources() -> Result<serde_json::Value, String> {
    let mut monitors = Vec::new();
    match Monitor::enumerate() {
        Ok(ms) => {
            for (i, m) in ms.iter().enumerate() {
                let title = m
                    .name()
                    .or_else(|_| m.device_string())
                    .unwrap_or_else(|_| format!("Монитор {}", i + 1));
                let (w, h) = (m.width().unwrap_or(0), m.height().unwrap_or(0));
                monitors.push(serde_json::json!({
                    "kind": "monitor", "id": i, "title": title, "w": w, "h": h
                }));
            }
        }
        Err(e) => return Err(format!("не удалось получить мониторы: {e}")),
    }
    let mut windows = Vec::new();
    if let Ok(ws) = Window::enumerate() {
        for w in ws {
            if !w.is_valid() {
                continue;
            }
            if let Ok(title) = w.title() {
                if title.trim().is_empty() {
                    continue;
                }
                windows.push(serde_json::json!({
                    "kind": "window", "id": title, "title": title
                }));
            }
        }
    }
    Ok(serde_json::json!({ "monitors": monitors, "windows": windows }))
}

/// Обёртка для переноса GraphicsCaptureItemType (содержит HWND — *mut c_void)
/// в поток захвата. HWND — просто число-идентификатор, передача между потоками
/// безопасна (MSDN: окна доступны из любого потока).
struct SendItem(windows_capture::settings::GraphicsCaptureItemType);
unsafe impl Send for SendItem {}
impl TryInto<windows_capture::settings::GraphicsCaptureItemType> for SendItem {
    type Error = &'static str;
    fn try_into(self) -> Result<windows_capture::settings::GraphicsCaptureItemType, Self::Error> {
        Ok(self.0)
    }
}

/// Запуск шаринга. kind: monitor(id=индекс) | window(id=заголовок).
/// on_video/on_audio — Channel'ы из JS (transformCallback).
#[tauri::command]
pub async fn screen_start(
    kind: String,
    id: serde_json::Value,
    audio: bool,
    on_video: Channel<InvokeResponseBody>,
    on_audio: Channel<InvokeResponseBody>,
) -> Result<serde_json::Value, String> {
    // уже идёт шаринг — сначала останавливаем
    screen_stop_impl();

    let audio_ch = if audio { Some(on_audio) } else { None };
    let state = ScreenShareState::new(on_video, audio_ch);

    // Источник захвата
    let item: windows_capture::settings::GraphicsCaptureItemType = match kind.as_str() {
        "monitor" => {
            let idx = id.as_u64().unwrap_or(0) as usize;
            Monitor::from_index(idx)
                .map_err(|e| format!("монитор {idx} не найден: {e}"))?
                .try_into()
                .map_err(|_| "не удалось преобразовать монитор".to_string())?
        }
        "window" => {
            let title = id.as_str().unwrap_or("").to_string();
            Window::from_name(&title)
                .map_err(|e| format!("окно «{title}» не найдено: {e}"))?
                .try_into()
                .map_err(|_| "не удалось преобразовать окно".to_string())?
        }
        other => return Err(format!("неизвестный тип источника: {other}")),
    };

    let fps = 15u32;
    let jpeg = ImageEncoder::new(ImageFormat::Jpeg, ImageEncoderPixelFormat::Bgra8)
        .map_err(|e| format!("кодек JPEG недоступен: {e}"))?;
    let vctx = Arc::new(VideoCtx {
        state: state.clone(),
        jpeg: std::sync::Mutex::new(jpeg),
        last: std::sync::Mutex::new(Instant::now()),
        fps,
    });

    let settings = Settings::new(
        SendItem(item),
        CursorCaptureSettings::Default,
        DrawBorderSettings::Default,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Custom(Duration::from_secs(1) / fps as u32),
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        vctx,
    );

    let control = ScreenVideo::start_free_threaded(settings)
        .map_err(|e| format!("не удалось запустить захват: {e}"))?;

    // Поток loopback-звука (WASAPI)
    let audio_thread = if audio {
        let st = state.clone();
        Some(std::thread::spawn(move || {
            if let Err(e) = loopback_thread(st) {
                eprintln!("screenshare audio: {e}");
            }
        }))
    } else {
        None
    };

    *SHARE.lock().unwrap() = Some(ShareHandle {
        state: state.clone(),
        video: Some(control),
        audio: audio_thread,
    });
    Ok(serde_json::json!({ "ok": true }))
}

/// Остановка шаринга (команда из JS).
#[tauri::command]
pub fn screen_stop() -> Result<(), String> {
    screen_stop_impl();
    Ok(())
}

fn screen_stop_impl() {
    if let Some(mut h) = SHARE.lock().unwrap().take() {
        h.state.stop();
        if let Some(v) = h.video.take() {
            let _ = v.stop();
        }
        if let Some(a) = h.audio.take() {
            let _ = a.join();
        }
    }
}

#[tauri::command]
pub fn screen_active() -> bool {
    SHARE
        .lock()
        .unwrap()
        .as_ref()
        .map(|h| !h.state.is_stopped())
        .unwrap_or(false)
}

/// WASAPI loopback: системный звук (то, что играет на выходе по умолчанию)
/// в формате f32le 48kHz stereo, чанками по ~20мс.
fn loopback_thread(
    state: Arc<ScreenShareState>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use wasapi::*;

    initialize_mta().ok()?;
    let enumerator = DeviceEnumerator::new()?;
    let device = enumerator.get_default_device(&Direction::Render)?;
    let mut client = device.get_iaudioclient()?;

    let fmt = WaveFormat::new(32, 32, &SampleType::Float, 48000, 2, None);
    let blockalign = fmt.get_blockalign() as usize;
    let (_, min_time) = client.get_device_period()?;
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: min_time,
    };
    client.initialize_client(&fmt, &Direction::Render, &mode)?;

    let event = client.set_get_eventhandle()?;
    let capture = client.get_audiocaptureclient()?;
    client.start_stream()?;

    let mut samples: std::collections::VecDeque<u8> =
        std::collections::VecDeque::with_capacity(48000 * 8);
    // чанк ~20мс: 48000 * 0.02 = 960 кадров
    let chunk_frames = 960usize;

    while !state.is_stopped() {
        capture.read_from_device_to_deque(&mut samples)?;
        while samples.len() >= blockalign * chunk_frames {
            let mut chunk = vec![0u8; blockalign * chunk_frames];
            for (dst, src) in chunk.iter_mut().zip(samples.iter()) {
                *dst = *src;
            }
            for _ in 0..chunk.len() {
                samples.pop_front();
            }
            if let Some(ch) = &state.audio_ch {
                let _ = ch.send(InvokeResponseBody::Raw(chunk));
            }
        }
        if event.wait_for_event(1000).is_err() {
            client.stop_stream()?;
            break;
        }
    }
    client.stop_stream()?;
    Ok(())
}
