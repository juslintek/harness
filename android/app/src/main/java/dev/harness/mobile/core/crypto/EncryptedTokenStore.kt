package dev.harness.mobile.core.crypto

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.security.SecureRandom
import java.security.Security
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

interface TokenStore {
    suspend fun saveToken(key: String, token: String)
    suspend fun getToken(key: String): String?
    suspend fun removeToken(key: String)
    suspend fun clear()
}

val Context.tokenDataStore: DataStore<Preferences> by preferencesDataStore(name = "harness_tokens")

class EncryptedTokenStore(
    private val dataStore: DataStore<Preferences>,
    private val keyAlias: String = "harness_token_store_aes"
) : TokenStore {

    constructor(context: Context, keyAlias: String = "harness_token_store_aes") : this(
        context.tokenDataStore,
        keyAlias
    )

    private val secureRandom = SecureRandom()
    private val secretKey: SecretKey by lazy { getOrCreateSecretKey() }

    private fun getOrCreateSecretKey(): SecretKey {
        val hasAndroidKeyStore = Security.getProviders().any { it.name == "AndroidKeyStore" }
        return if (hasAndroidKeyStore) {
            val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            if (!keyStore.containsAlias(keyAlias)) {
                val kgClass = Class.forName("android.security.keystore.KeyGenParameterSpec\$Builder")
                val kpClass = Class.forName("android.security.keystore.KeyProperties")
                val purposeEncrypt = kpClass.getField("PURPOSE_ENCRYPT").getInt(null)
                val purposeDecrypt = kpClass.getField("PURPOSE_DECRYPT").getInt(null)
                val blockModeGcm = kpClass.getField("BLOCK_MODE_GCM").get(null) as String
                val paddingNone = kpClass.getField("ENCRYPTION_PADDING_NONE").get(null) as String

                val builderConstructor = kgClass.getConstructor(String::class.java, Int::class.javaPrimitiveType)
                val builder = builderConstructor.newInstance(keyAlias, purposeEncrypt or purposeDecrypt)

                kgClass.getMethod("setBlockModes", Array<String>::class.java)
                    .invoke(builder, arrayOf(blockModeGcm))
                kgClass.getMethod("setEncryptionPaddings", Array<String>::class.java)
                    .invoke(builder, arrayOf(paddingNone))
                kgClass.getMethod("setKeySize", Int::class.javaPrimitiveType)
                    .invoke(builder, 256)

                val spec = kgClass.getMethod("build").invoke(builder)
                val keyGen = KeyGenerator.getInstance("AES", "AndroidKeyStore")
                keyGen.init(spec as java.security.spec.AlgorithmParameterSpec)
                keyGen.generateKey()
            } else {
                keyStore.getKey(keyAlias, null) as SecretKey
            }
        } else {
            // JVM fallback for unit tests
            val rawKey = ByteArray(32) { (it * 31).toByte() }
            SecretKeySpec(rawKey, "AES")
        }
    }

    private fun encrypt(plainText: String): String {
        val iv = ByteArray(12)
        secureRandom.nextBytes(iv)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey, GCMParameterSpec(128, iv))
        val cipherText = cipher.doFinal(plainText.toByteArray(StandardCharsets.UTF_8))
        val combined = ByteArray(iv.size + cipherText.size)
        System.arraycopy(iv, 0, combined, 0, iv.size)
        System.arraycopy(cipherText, 0, combined, iv.size, cipherText.size)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(combined)
    }

    private fun decrypt(encryptedBase64: String): String? {
        return try {
            val combined = Base64.getUrlDecoder().decode(encryptedBase64)
            if (combined.size < 12 + 16) return null
            val iv = ByteArray(12)
            val cipherText = ByteArray(combined.size - 12)
            System.arraycopy(combined, 0, iv, 0, 12)
            System.arraycopy(combined, 12, cipherText, 0, cipherText.size)

            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, secretKey, GCMParameterSpec(128, iv))
            val plainBytes = cipher.doFinal(cipherText)
            String(plainBytes, StandardCharsets.UTF_8)
        } catch (_: Exception) {
            null
        }
    }

    override suspend fun saveToken(key: String, token: String) {
        val encrypted = encrypt(token)
        val prefKey = stringPreferencesKey(key)
        dataStore.edit { prefs ->
            prefs[prefKey] = encrypted
        }
    }

    override suspend fun getToken(key: String): String? {
        val prefKey = stringPreferencesKey(key)
        val encrypted = dataStore.data.map { prefs -> prefs[prefKey] }.first() ?: return null
        return decrypt(encrypted)
    }

    override suspend fun removeToken(key: String) {
        val prefKey = stringPreferencesKey(key)
        dataStore.edit { prefs ->
            prefs.remove(prefKey)
        }
    }

    override suspend fun clear() {
        dataStore.edit { prefs ->
            prefs.clear()
        }
    }
}

class InMemoryTokenStore : TokenStore {
    private val map = mutableMapOf<String, String>()

    override suspend fun saveToken(key: String, token: String) {
        map[key] = token
    }

    override suspend fun getToken(key: String): String? = map[key]

    override suspend fun removeToken(key: String) {
        map.remove(key)
    }

    override suspend fun clear() {
        map.clear()
    }
}
