package dev.harness.mobile.core.model

import kotlinx.serialization.Serializable

@Serializable
data class CryptoP256Vector(
    val rpOrigin: String,
    val sessionId: String,
    val challengeId: String,
    val nonce: String,
    val canonicalPayload: String,
    val publicKeySpki: String,
    val signature: String
)
