package dev.harness.mobile.features.workspace

import android.content.Context
import android.content.Intent
import android.net.Uri

object AdminHandoffHelper {

    val ORG_SECTIONS = listOf(
        "hiring" to "Hiring & Roles",
        "policies" to "Policies & Security",
        "logs" to "Audit Logs",
        "settings" to "Org Settings"
    )

    val INSTANCE_ADMIN_SECTIONS = listOf(
        "agents" to "Agent Fleet",
        "search" to "Vector & Search",
        "integrations" to "Integrations",
        "federation" to "Federation",
        "deploy" to "Deployment",
        "updates" to "System Updates"
    )

    fun buildOrgUrl(instanceOrigin: String, orgSlug: String, section: String): String {
        val base = instanceOrigin.trimEnd('/')
        return "$base/#/o/$orgSlug/$section"
    }

    fun buildAdminUrl(instanceOrigin: String, section: String): String {
        val base = instanceOrigin.trimEnd('/')
        return "$base/#/$section"
    }

    fun openBrowser(context: Context, url: String): Boolean {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return try {
            context.startActivity(intent)
            true
        } catch (_: Exception) {
            false
        }
    }
}
