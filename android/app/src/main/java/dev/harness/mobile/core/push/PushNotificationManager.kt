package dev.harness.mobile.core.push

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import dev.harness.mobile.MainActivity
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
data class PushPayload(
    val deepLink: String,
    val instanceOrigin: String? = null,
    val kind: String,
    val urgency: String? = null,
    val tag: String? = null,
    val title: String? = null,
    val body: String? = null
)

object PushNotificationManager {
    const val CHANNEL_GUARD_URGENT = "harness_guard_urgent"
    const val CHANNEL_ACTIVITY = "harness_activity"

    const val ACTION_PUSH_EVENT = "dev.harness.mobile.PUSH_EVENT"
    const val ACTION_UNIFIED_PUSH_MESSAGE = "org.unifiedpush.android.connector.MESSAGE"

    const val EXTRA_DEEP_LINK = "deepLink"
    const val EXTRA_INSTANCE_ORIGIN = "instanceOrigin"
    const val EXTRA_KIND = "kind"
    const val EXTRA_URGENCY = "urgency"
    const val EXTRA_TAG = "tag"
    const val EXTRA_TITLE = "title"
    const val EXTRA_BODY = "body"
    const val EXTRA_PAYLOAD = "payload"

    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
    }

    private val URGENT_KINDS = setOf("approval_requested", "run_blocked")
    private val ACTIVITY_KINDS = setOf("mention", "dm", "approval_resolved")

    fun channelIdFor(kind: String, urgency: String? = null): String {
        val normalizedKind = kind.trim().lowercase()
        val normalizedUrgency = urgency?.trim()?.lowercase()
        return when {
            normalizedKind in URGENT_KINDS -> CHANNEL_GUARD_URGENT
            normalizedUrgency == "high" || normalizedUrgency == "urgent" -> CHANNEL_GUARD_URGENT
            normalizedKind in ACTIVITY_KINDS -> CHANNEL_ACTIVITY
            else -> CHANNEL_ACTIVITY
        }
    }

    fun ensureChannels(context: Context) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            ?: return

        val guardChannel = NotificationChannel(
            CHANNEL_GUARD_URGENT,
            "Guard & Urgent Alerts",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "Pending guard approvals and blocked agent runs"
            enableVibration(true)
        }

        val activityChannel = NotificationChannel(
            CHANNEL_ACTIVITY,
            "Activity & Mentions",
            NotificationManager.IMPORTANCE_DEFAULT
        ).apply {
            description = "Chat mentions, direct messages, and resolved approvals"
        }

        manager.createNotificationChannel(guardChannel)
        manager.createNotificationChannel(activityChannel)
    }

    fun parseIntentPayload(intent: Intent?): PushPayload? {
        if (intent == null) return null
        val rawJson = intent.getStringExtra("message")
            ?: intent.getStringExtra(EXTRA_PAYLOAD)
        if (!rawJson.isNullOrBlank()) {
            try {
                return json.decodeFromString<PushPayload>(rawJson)
            } catch (_: Exception) {
                // Fall through to individual extras
            }
        }

        val deepLink = intent.getStringExtra(EXTRA_DEEP_LINK) ?: return null
        val kind = intent.getStringExtra(EXTRA_KIND) ?: "mention"
        return PushPayload(
            deepLink = deepLink,
            instanceOrigin = intent.getStringExtra(EXTRA_INSTANCE_ORIGIN),
            kind = kind,
            urgency = intent.getStringExtra(EXTRA_URGENCY),
            tag = intent.getStringExtra(EXTRA_TAG),
            title = intent.getStringExtra(EXTRA_TITLE),
            body = intent.getStringExtra(EXTRA_BODY)
        )
    }

    fun buildLaunchIntent(context: Context, payload: PushPayload): Intent {
        return Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            data = Uri.parse(payload.deepLink)
            if (!payload.instanceOrigin.isNullOrBlank()) {
                putExtra(EXTRA_INSTANCE_ORIGIN, payload.instanceOrigin)
            }
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_CLEAR_TOP or
                Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
    }

    fun postNotification(context: Context, payload: PushPayload): Boolean {
        ensureChannels(context)
        if (Build.VERSION.SDK_INT >= 33) {
            val granted = context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED
            if (!granted) return false
        }

        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            ?: return false

        val channelId = channelIdFor(payload.kind, payload.urgency)
        val launchIntent = buildLaunchIntent(context, payload)
        val requestCode = (payload.tag ?: payload.deepLink).hashCode()
        val pendingIntent = PendingIntent.getActivity(
            context,
            requestCode,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val defaultTitle = when (payload.kind.lowercase()) {
            "approval_requested" -> "Guard approval requested"
            "run_blocked" -> "Agent run blocked"
            "approval_resolved" -> "Approval resolved"
            "dm" -> "New direct message"
            else -> "New mention in Harness"
        }

        val actionLabel = if (payload.kind.lowercase() == "approval_requested") "Review" else "Open"
        val openAction = Notification.Action.Builder(
            Icon.createWithResource(context, android.R.drawable.ic_menu_view),
            actionLabel,
            pendingIntent
        ).build()

        val notification = Notification.Builder(context, channelId)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(payload.title?.takeIf { it.isNotBlank() } ?: defaultTitle)
            .setContentText(payload.body?.takeIf { it.isNotBlank() } ?: payload.deepLink)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .addAction(openAction)
            .build()

        val tag = payload.tag ?: payload.deepLink
        manager.notify(tag, requestCode, notification)
        return true
    }
}

class PushEndpointReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        if (action != PushNotificationManager.ACTION_PUSH_EVENT &&
            action != PushNotificationManager.ACTION_UNIFIED_PUSH_MESSAGE
        ) {
            return
        }
        val payload = PushNotificationManager.parseIntentPayload(intent) ?: return
        PushNotificationManager.postNotification(context, payload)
    }
}
