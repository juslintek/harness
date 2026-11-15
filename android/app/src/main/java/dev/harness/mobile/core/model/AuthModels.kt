package dev.harness.mobile.core.model

import kotlinx.serialization.Serializable

@Serializable
data class MeResponse(
    val user: UserView,
    val session: SessionView,
    val orgs: List<OrgView> = emptyList(),
    val devices: List<DeviceView> = emptyList()
)

@Serializable
data class UserView(
    val id: String,
    val email: String,
    val name: String,
    val instanceAdmin: Boolean = false,
    val createdAt: Long = 0L
)

@Serializable
data class SessionView(
    val id: String,
    val method: String,
    val stepUpAt: Long? = null,
    val stepUpFresh: Boolean = false
)

@Serializable
data class OrgView(
    val id: String,
    val slug: String,
    val name: String,
    val personal: Boolean = false,
    val createdAt: Long = 0L,
    val role: String = "member"
)

@Serializable
data class DeviceView(
    val id: String,
    val name: String,
    val platform: String,
    val createdAt: Long = 0L,
    val lastUsedAt: Long = 0L,
    val current: Boolean = false
)

@Serializable
data class MobilePairStartResult(
    val code: String,
    val expiresAt: Long,
    val uri: String
)

@Serializable
data class MobilePairOptionsBody(
    val code: String,
    val deviceName: String,
    val platform: String = "android"
)

@Serializable
data class MobilePairOptionsResponse(
    val challengeId: String,
    val nonce: String,
    val rpOrigin: String? = null
)

@Serializable
data class MobilePairVerifyBody(
    val challengeId: String,
    val code: String,
    val deviceName: String,
    val platform: String = "android",
    val publicKeySpki: String,
    val signature: String
)

@Serializable
data class MobilePairVerifyResponse(
    val token: String,
    val deviceId: String,
    val user: UserView
)

@Serializable
data class MobileEnrollOptionsBody(
    val email: String? = null,
    val name: String? = null,
    val deviceName: String,
    val platform: String = "android"
)

@Serializable
data class MobileEnrollOptionsResponse(
    val challengeId: String,
    val nonce: String,
    val rpOrigin: String? = null,
    val userId: String? = null
)

@Serializable
data class MobileEnrollVerifyBody(
    val challengeId: String,
    val userId: String? = null,
    val deviceName: String,
    val platform: String = "android",
    val publicKeySpki: String,
    val signature: String
)

@Serializable
data class MobileEnrollVerifyResponse(
    val token: String,
    val deviceId: String,
    val user: UserView,
    val recoveryCodes: List<String> = emptyList()
)

@Serializable
data class MobileStepUpOptionsResponse(
    val challengeId: String,
    val nonce: String,
    val expiresAt: Long? = null
)

@Serializable
data class MobileStepUpVerifyBody(
    val challengeId: String,
    val signature: String
)

@Serializable
data class MobileStepUpVerifyResponse(
    val ok: Boolean = true,
    val stepUpAt: Long? = null
)

@Serializable
data class HaltBody(
    val halted: Boolean
)

@Serializable
data class HaltResponse(
    val halted: Boolean
)

@Serializable
data class MobilePushSubscribeBody(
    val relayUrl: String,
    val platform: String = "android",
    val appId: String,
    val pushToken: String,
    val relaySecret: String? = null
)

@Serializable
data class ErrorResponse(
    val error: String,
    val challengeId: String? = null
)
