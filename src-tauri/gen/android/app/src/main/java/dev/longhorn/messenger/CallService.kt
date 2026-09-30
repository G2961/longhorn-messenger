package dev.longhorn.messenger

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Foreground-сервис активного звонка: не даёт Android заморозить процесс
 * (и оборвать WebRTC/WS) при свёрнутом приложении. Тип microphone гарантирует,
 * что запись с микрофона продолжается в фоне.
 *
 * Старт/стоп — из Rust (lib.rs) top-level функциями callServiceStart/Stop,
 * которые дергаются из JS при входе в разговор и при cleanupCall.
 */
class CallService : Service() {

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(
                NotificationChannel(CH_ID, "Звонок", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Идёт звонок Longhorn Messenger"
                    setShowBadge(false)
                }
            )
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        val peer = intent?.getStringExtra("peer") ?: ""
        val pi = PendingIntent.getActivity(
            this, 0,
            packageManager.getLaunchIntentForPackage(packageName)?.apply {
                addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            } ?: Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val text = if (peer.isNotEmpty()) "Разговор с $peer" else "Разговор"
        val nb = NotificationCompat.Builder(this, if (Build.VERSION.SDK_INT >= 26) CH_ID else "")
            .setSmallIcon(android.R.drawable.ic_dialog_dialer)
            .setContentTitle("Longhorn Messenger")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(pi)
            .setCategory(NotificationCompat.CATEGORY_CALL)
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIF_ID, nb.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            } else {
                startForeground(NOTIF_ID, nb.build())
            }
        } catch (e: Exception) {
            // нет права (например, FGS не в allow-list) — звонок без фона, но не роняем приложение
        }
        return START_STICKY
    }

    override fun onDestroy() {
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIF_ID)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val CH_ID = "lh_call"
        private const val NOTIF_ID = 42
        const val ACTION_STOP = "dev.longhorn.messenger.CALL_STOP"
    }
}

/** Top-level функции для JNI-вызова из Rust (companion-методы JNI не видит). */
fun callServiceStart(ctx: Context, peer: String) {
    val i = Intent(ctx, CallService::class.java).apply { putExtra("peer", peer) }
    try { ctx.startForegroundService(i) } catch (e: Exception) {
        try { ctx.startService(i) } catch (e2: Exception) {}
    }
}

fun callServiceStop(ctx: Context) {
    try {
        ctx.startService(Intent(ctx, CallService::class.java).apply { action = CallService.ACTION_STOP })
    } catch (e: Exception) {
        try { ctx.stopService(Intent(ctx, CallService::class.java)) } catch (e2: Exception) {}
    }
}
