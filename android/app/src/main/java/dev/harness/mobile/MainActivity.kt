package dev.harness.mobile

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.lifecycle.lifecycleScope
import dev.harness.mobile.core.crypto.DeviceKeySigner
import dev.harness.mobile.core.crypto.EncryptedTokenStore
import dev.harness.mobile.core.network.HarnessApiClient
import dev.harness.mobile.core.push.DeepLinkParser
import dev.harness.mobile.core.push.DeepLinkTarget
import dev.harness.mobile.core.push.PushNotificationManager
import dev.harness.mobile.core.store.InstanceRepository
import dev.harness.mobile.core.store.SessionRepository
import dev.harness.mobile.theme.StudioNorthTheme
import dev.harness.mobile.ui.shell.HarnessAppShell
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {

    private lateinit var instanceRepo: InstanceRepository
    private lateinit var tokenStore: EncryptedTokenStore
    private lateinit var sessionRepo: SessionRepository
    private lateinit var deviceKeySigner: DeviceKeySigner
    private val pendingDeepLink = MutableStateFlow<DeepLinkTarget?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        instanceRepo = InstanceRepository()
        tokenStore = EncryptedTokenStore(applicationContext)
        sessionRepo = SessionRepository(tokenStore)
        deviceKeySigner = DeviceKeySigner.create()

        PushNotificationManager.ensureChannels(this)
        handleDeepLink(intent)
        attemptAutoLogin()

        setContent {
            val deepLink by pendingDeepLink.collectAsState()
            StudioNorthTheme {
                HarnessAppShell(
                    instanceRepo = instanceRepo,
                    sessionRepo = sessionRepo,
                    deviceKeySigner = deviceKeySigner,
                    pendingDeepLink = deepLink,
                    onDeepLinkConsumed = { pendingDeepLink.value = null }
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleDeepLink(intent)
    }

    private fun handleDeepLink(intent: Intent?) {
        val originExtra = intent?.getStringExtra(PushNotificationManager.EXTRA_INSTANCE_ORIGIN)
        val target = DeepLinkParser.parse(intent?.dataString, originExtra) ?: return

        val origin = target.instanceOrigin?.trim()?.trimEnd('/')
        if (!origin.isNullOrBlank()) {
            val existing = instanceRepo.instances.value.find {
                it.originUrl.trimEnd('/').equals(origin, ignoreCase = true)
            }
            if (existing != null) {
                instanceRepo.selectInstance(existing.id)
            } else {
                instanceRepo.addInstance("Paired Instance", origin)
            }
        }

        pendingDeepLink.value = target
    }

    private fun attemptAutoLogin() {
        lifecycleScope.launch {
            val storedToken = sessionRepo.getStoredToken() ?: return@launch
            val activeInst = instanceRepo.activeInstance.value
            val client = HarnessApiClient(
                baseUrl = activeInst.originUrl,
                tokenProvider = { storedToken },
                signerProvider = { deviceKeySigner }
            )
            try {
                val me = withContext(Dispatchers.IO) { client.getMe() }
                sessionRepo.authenticate(storedToken, me)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Keep unauthenticated or prompt re-auth
            }
        }
    }
}
