package dev.longhorn.messenger

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // отладка WebView через chrome://inspect (личное приложение; убрать перед стором)
    WebView.setWebContentsDebuggingEnabled(true)
  }
}
