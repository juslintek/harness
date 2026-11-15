package dev.harness.mobile.core.crypto

import java.nio.charset.StandardCharsets
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.PublicKey
import java.security.Security
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

interface DeviceKeySigner {
    fun getPublicKeySpki(): String
    fun sign(payload: String): String
    fun verify(payload: String, signatureBase64Url: String, spkiBase64Url: String = getPublicKeySpki()): Boolean

    companion object {
        const val SIGNATURE_ALGORITHM = "SHA256withECDSAinP1363Format"
        const val EC_CURVE = "secp256r1"

        fun create(alias: String = "harness_device_key", forceJvm: Boolean = false): DeviceKeySigner {
            val isAndroidKeyStoreAvailable = !forceJvm && Security.getProviders().any { it.name == "AndroidKeyStore" }
            return if (isAndroidKeyStoreAvailable) {
                AndroidKeyStoreSigner(alias)
            } else {
                JvmSoftwareSigner()
            }
        }

        fun buildEnrollPayload(rpOrigin: String, challengeId: String, nonce: String): String {
            require(!rpOrigin.contains("|") && !challengeId.contains("|") && !nonce.contains("|"))
            return "harness-mobile-enroll-v1|$rpOrigin|$challengeId|$nonce"
        }

        fun buildPairPayload(rpOrigin: String, challengeId: String, nonce: String): String {
            require(!rpOrigin.contains("|") && !challengeId.contains("|") && !nonce.contains("|"))
            return "harness-mobile-pair-v1|$rpOrigin|$challengeId|$nonce"
        }

        fun buildStepUpPayload(rpOrigin: String, sessionId: String, challengeId: String, nonce: String): String {
            require(!rpOrigin.contains("|") && !sessionId.contains("|") && !challengeId.contains("|") && !nonce.contains("|"))
            return "harness-mobile-stepup-v1|$rpOrigin|$sessionId|$challengeId|$nonce"
        }

        fun verifySignature(payload: String, signatureBase64Url: String, spkiBase64Url: String): Boolean {
            return try {
                val spkiBytes = Base64.getUrlDecoder().decode(spkiBase64Url)
                val sigBytes = Base64.getUrlDecoder().decode(signatureBase64Url)
                if (sigBytes.size != 64) return false

                val keyFactory = KeyFactory.getInstance("EC")
                val publicKey = keyFactory.generatePublic(X509EncodedKeySpec(spkiBytes))
                val verifier = Signature.getInstance(SIGNATURE_ALGORITHM)
                verifier.initVerify(publicKey)
                verifier.update(payload.toByteArray(StandardCharsets.UTF_8))
                verifier.verify(sigBytes)
            } catch (_: Exception) {
                false
            }
        }
    }
}

class JvmSoftwareSigner(keyPair: KeyPair? = null) : DeviceKeySigner {
    private val keyPair: KeyPair = keyPair ?: run {
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec(DeviceKeySigner.EC_CURVE))
        generator.generateKeyPair()
    }

    override fun getPublicKeySpki(): String {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(keyPair.public.encoded)
    }

    override fun sign(payload: String): String {
        val signer = Signature.getInstance(DeviceKeySigner.SIGNATURE_ALGORITHM)
        signer.initSign(keyPair.private)
        signer.update(payload.toByteArray(StandardCharsets.UTF_8))
        val rawSig = signer.sign()
        check(rawSig.size == 64) { "Signature size was ${rawSig.size}, expected 64 bytes IEEE P1363" }
        return Base64.getUrlEncoder().withoutPadding().encodeToString(rawSig)
    }

    override fun verify(payload: String, signatureBase64Url: String, spkiBase64Url: String): Boolean {
        return DeviceKeySigner.verifySignature(payload, signatureBase64Url, spkiBase64Url)
    }
}

class AndroidKeyStoreSigner(
    private val alias: String = "harness_device_key"
) : DeviceKeySigner {
    private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    init {
        ensureKey()
    }

    private fun ensureKey() {
        if (!keyStore.containsAlias(alias)) {
            val kpgClass = Class.forName("android.security.keystore.KeyGenParameterSpec\$Builder")
            val kpClass = Class.forName("android.security.keystore.KeyProperties")
            val purposeSign = kpClass.getField("PURPOSE_SIGN").getInt(null)
            val purposeVerify = kpClass.getField("PURPOSE_VERIFY").getInt(null)
            val digestSha256 = kpClass.getField("DIGEST_SHA256").get(null) as String

            val builderConstructor = kpgClass.getConstructor(String::class.java, Int::class.javaPrimitiveType)
            val builder = builderConstructor.newInstance(alias, purposeSign or purposeVerify)

            kpgClass.getMethod("setAlgorithmParameterSpec", java.security.spec.AlgorithmParameterSpec::class.java)
                .invoke(builder, ECGenParameterSpec(DeviceKeySigner.EC_CURVE))

            kpgClass.getMethod("setDigests", Array<String>::class.java)
                .invoke(builder, arrayOf(digestSha256))

            val spec = kpgClass.getMethod("build").invoke(builder)

            val kpg = KeyPairGenerator.getInstance("EC", "AndroidKeyStore")
            kpg.initialize(spec as java.security.spec.AlgorithmParameterSpec)
            kpg.generateKeyPair()
        }
    }

    override fun getPublicKeySpki(): String {
        val cert = keyStore.getCertificate(alias) ?: error("Certificate for $alias not found")
        return Base64.getUrlEncoder().withoutPadding().encodeToString(cert.publicKey.encoded)
    }

    override fun sign(payload: String): String {
        val entry = keyStore.getEntry(alias, null) as? KeyStore.PrivateKeyEntry
            ?: error("Key entry for $alias not found")
        val signer = Signature.getInstance("SHA256withECDSA")
        signer.initSign(entry.privateKey)
        signer.update(payload.toByteArray(StandardCharsets.UTF_8))
        val rawSig = derToP1363(signer.sign())
        return Base64.getUrlEncoder().withoutPadding().encodeToString(rawSig)
    }

    private fun derToP1363(der: ByteArray): ByteArray {
        if (der.size == 64 && der[0] != 0x30.toByte()) return der
        var idx = 0
        require(der[idx++] == 0x30.toByte()) { "Invalid DER sequence" }
        if ((der[idx].toInt() and 0x80) != 0) idx += 1 + (der[idx].toInt() and 0x7F) else idx++
        val out = ByteArray(64)
        for (part in 0..1) {
            require(der[idx++] == 0x02.toByte()) { "Invalid DER integer" }
            val len = der[idx++].toInt() and 0xFF
            val srcPos = if (len > 32) idx + (len - 32) else idx
            val copyLen = minOf(len, 32)
            System.arraycopy(der, srcPos, out, part * 32 + (32 - copyLen), copyLen)
            idx += len
        }
        return out
    }

    override fun verify(payload: String, signatureBase64Url: String, spkiBase64Url: String): Boolean {
        return DeviceKeySigner.verifySignature(payload, signatureBase64Url, spkiBase64Url)
    }
}
