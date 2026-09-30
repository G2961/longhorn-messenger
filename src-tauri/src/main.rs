// Превентивно запрещаем диалог Windows «приложение не отвечает»,
// пока Go-сервер стартует и webview грузит статический фронтенд.
#![windows_subsystem = "windows"]

fn main() {
    longhorn_messenger_lib::run();
}
