package dev.harness.mobile.features.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.harness.mobile.core.crypto.DeviceKeySigner
import dev.harness.mobile.core.model.MobileEnrollOptionsBody
import dev.harness.mobile.core.model.MobileEnrollVerifyBody
import dev.harness.mobile.core.model.MobilePairVerifyBody
import dev.harness.mobile.core.network.HarnessApiClient
import dev.harness.mobile.core.store.InstanceRepository
import dev.harness.mobile.core.store.SessionRepository
import dev.harness.mobile.theme.ActionPill
import dev.harness.mobile.theme.RaisedCard
import dev.harness.mobile.theme.SecondaryLinkButton
import dev.harness.mobile.theme.StudioNorthTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun PairEnrollScreen(
    instanceRepo: InstanceRepository,
    sessionRepo: SessionRepository,
    deviceKeySigner: DeviceKeySigner,
    modifier: Modifier = Modifier,
    initialOrigin: String? = null,
    initialCode: String? = null,
    onConnected: () -> Unit = {}
) {
    val colors = StudioNorthTheme.colors
    val scope = rememberCoroutineScope()

    var instanceUrl by remember { mutableStateOf(initialOrigin ?: instanceRepo.activeInstance.value.originUrl) }
    var codeInput by remember { mutableStateOf(initialCode ?: "") }
    var isEnrollMode by remember { mutableStateOf(false) }
    var showQrScanner by remember { mutableStateOf(false) }
    var isLoading by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(initialOrigin, initialCode) {
        if (!initialOrigin.isNullOrBlank()) instanceUrl = initialOrigin
        if (!initialCode.isNullOrBlank()) codeInput = initialCode
    }

    if (showQrScanner) {
        QrScannerDialog(
            onScanned = { origin, code ->
                showQrScanner = false
                if (origin.isNotBlank()) instanceUrl = origin
                codeInput = code
            },
            onDismiss = { showQrScanner = false }
        )
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(colors.surface)
            .padding(24.dp),
        contentAlignment = Alignment.Center
    ) {
        RaisedCard(
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(
                text = "Harness Mobile",
                fontSize = 22.sp,
                fontWeight = FontWeight.Bold,
                color = colors.ink
            )
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = if (isEnrollMode) "First-time server enrollment" else "Pair device with existing instance",
                fontSize = 14.sp,
                color = colors.inkMuted
            )

            Spacer(modifier = Modifier.height(20.dp))

            OutlinedTextField(
                value = instanceUrl,
                onValueChange = { instanceUrl = it },
                label = { Text("Instance Origin URL") },
                singleLine = true,
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("input.origin_url")
                    .semantics { contentDescription = "Instance Origin URL" },
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = colors.brand,
                    unfocusedBorderColor = colors.border,
                    focusedTextColor = colors.ink,
                    unfocusedTextColor = colors.ink
                )
            )

            Spacer(modifier = Modifier.height(12.dp))

            OutlinedTextField(
                value = codeInput,
                onValueChange = { codeInput = it },
                label = { Text(if (isEnrollMode) "Enrollment Code" else "Pairing Code") },
                singleLine = true,
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("input.pair_code")
                    .semantics {
                        contentDescription = if (isEnrollMode) "Enrollment Code" else "Pairing Code"
                    },
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = colors.brand,
                    unfocusedBorderColor = colors.border,
                    focusedTextColor = colors.ink,
                    unfocusedTextColor = colors.ink
                )
            )

            if (!errorMessage.isNullOrBlank()) {
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = errorMessage ?: "",
                    color = colors.danger,
                    fontSize = 13.sp,
                    modifier = Modifier.testTag("pair.error")
                )
            }

            Spacer(modifier = Modifier.height(20.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                SecondaryLinkButton(
                    text = "Scan QR",
                    onClick = { showQrScanner = true },
                    modifier = Modifier.testTag("button.scan_qr")
                )

                ActionPill(
                    text = if (isLoading) "Connecting..." else "Connect",
                    enabled = !isLoading && codeInput.isNotBlank() && instanceUrl.isNotBlank(),
                    modifier = Modifier.testTag("button.connect"),
                    onClick = {
                        isLoading = true
                        errorMessage = null
                        scope.launch {
                            try {
                                val cleanUrl = instanceUrl.trim().trimEnd('/')
                                instanceRepo.addInstance("Instance", cleanUrl)

                                val client = HarnessApiClient(
                                    baseUrl = cleanUrl,
                                    tokenProvider = { null },
                                    signerProvider = { deviceKeySigner }
                                )

                                val token = withContext(Dispatchers.IO) {
                                    if (isEnrollMode) {
                                        val opt = client.enrollOptions(
                                            codeInput.trim(),
                                            MobileEnrollOptionsBody(
                                                deviceName = "Android Device",
                                                platform = "android"
                                            )
                                        )
                                        val canonical = DeviceKeySigner.buildEnrollPayload(
                                            rpOrigin = opt.rpOrigin ?: cleanUrl,
                                            challengeId = opt.challengeId,
                                            nonce = opt.nonce
                                        )
                                        val sig = deviceKeySigner.sign(canonical)
                                        val ver = client.enrollVerify(
                                            codeInput.trim(),
                                            MobileEnrollVerifyBody(
                                                challengeId = opt.challengeId,
                                                userId = opt.userId,
                                                deviceName = "Android Device",
                                                platform = "android",
                                                publicKeySpki = deviceKeySigner.getPublicKeySpki(),
                                                signature = sig
                                            )
                                        )
                                        ver.token
                                    } else {
                                        val opt = client.pairOptions(
                                            codeInput.trim(),
                                            "Android Device"
                                        )
                                        val canonical = DeviceKeySigner.buildPairPayload(
                                            rpOrigin = opt.rpOrigin ?: cleanUrl,
                                            challengeId = opt.challengeId,
                                            nonce = opt.nonce
                                        )
                                        val sig = deviceKeySigner.sign(canonical)
                                        val ver = client.pairVerify(
                                            MobilePairVerifyBody(
                                                challengeId = opt.challengeId,
                                                code = codeInput.trim(),
                                                deviceName = "Android Device",
                                                platform = "android",
                                                publicKeySpki = deviceKeySigner.getPublicKeySpki(),
                                                signature = sig
                                            )
                                        )
                                        ver.token
                                    }
                                }

                                val authedClient = HarnessApiClient(
                                    baseUrl = cleanUrl,
                                    tokenProvider = { token },
                                    signerProvider = { deviceKeySigner }
                                )
                                val me = withContext(Dispatchers.IO) { authedClient.getMe() }
                                sessionRepo.authenticate(token, me)
                                onConnected()
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                errorMessage = e.message ?: "Authentication failed"
                            } finally {
                                isLoading = false
                            }
                        }
                    }
                )
            }

            Spacer(modifier = Modifier.height(16.dp))

            SecondaryLinkButton(
                text = if (isEnrollMode) "Switch to Pair Code" else "Switch to First-Time Enroll",
                onClick = {
                    isEnrollMode = !isEnrollMode
                    errorMessage = null
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("button.toggle_enroll_mode")
            )
        }
    }
}
