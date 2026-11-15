package dev.harness.mobile.core.push

import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

sealed interface DeepLinkTarget {
    val instanceOrigin: String?

    data class Pair(
        val origin: String?,
        val code: String?
    ) : DeepLinkTarget {
        override val instanceOrigin: String? get() = origin
    }

    data class Approval(
        val approvalId: String?,
        override val instanceOrigin: String? = null
    ) : DeepLinkTarget

    data class Run(
        val runId: String?,
        override val instanceOrigin: String? = null
    ) : DeepLinkTarget

    data class Chat(
        val orgSlug: String?,
        val channelId: String?,
        override val instanceOrigin: String? = null
    ) : DeepLinkTarget
}

object DeepLinkParser {

    fun parse(uriString: String?, instanceOriginOverride: String? = null): DeepLinkTarget? {
        if (uriString.isNullOrBlank()) return null
        val uri = try {
            URI(uriString.trim())
        } catch (_: Exception) {
            return null
        }

        if (!"harness".equals(uri.scheme, ignoreCase = true)) return null
        val host = uri.host?.lowercase() ?: return null
        val query = parseQuery(uri.rawQuery)
        val segments = (uri.path ?: "")
            .split('/')
            .filter { it.isNotBlank() }
            .map { decode(it) }

        val resolvedOrigin = instanceOriginOverride?.takeIf { it.isNotBlank() }
            ?: query["origin"]?.takeIf { it.isNotBlank() }
            ?: query["instanceOrigin"]?.takeIf { it.isNotBlank() }

        return when (host) {
            "pair" -> DeepLinkTarget.Pair(
                origin = resolvedOrigin,
                code = query["code"]?.takeIf { it.isNotBlank() }
            )
            "approvals" -> DeepLinkTarget.Approval(
                approvalId = segments.firstOrNull(),
                instanceOrigin = resolvedOrigin
            )
            "runs" -> DeepLinkTarget.Run(
                runId = segments.firstOrNull(),
                instanceOrigin = resolvedOrigin
            )
            "chat" -> DeepLinkTarget.Chat(
                orgSlug = segments.getOrNull(0),
                channelId = segments.getOrNull(1),
                instanceOrigin = resolvedOrigin
            )
            else -> null
        }
    }

    private fun parseQuery(rawQuery: String?): Map<String, String> {
        if (rawQuery.isNullOrBlank()) return emptyMap()
        val result = mutableMapOf<String, String>()
        for (pair in rawQuery.split('&')) {
            val idx = pair.indexOf('=')
            if (idx > 0) {
                val key = decode(pair.substring(0, idx))
                val value = decode(pair.substring(idx + 1))
                result[key] = value
            }
        }
        return result
    }

    private fun decode(value: String): String =
        URLDecoder.decode(value, StandardCharsets.UTF_8.name())
}
