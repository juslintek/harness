package dev.harness.mobile.features.approvals

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.harness.mobile.core.model.ApprovalView
import dev.harness.mobile.core.model.DecisionBody
import dev.harness.mobile.core.model.ErrorResponse
import dev.harness.mobile.core.model.WsMessage
import dev.harness.mobile.core.network.HarnessWsClient
import dev.harness.mobile.core.store.SessionRepository
import dev.harness.mobile.core.store.SessionState
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.Locale

class ApprovalsViewModel(
    val session: SessionRepository,
    val baseUrl: String = "http://127.0.0.1:4100",
    private val customClient: OkHttpClient? = null,
    private val wsFactory: ((url: String) -> HarnessWsClient)? = null,
    coroutineScope: CoroutineScope? = null,
    private val ioDispatcher: CoroutineDispatcher = coroutineScope?.coroutineContext?.get(CoroutineDispatcher) ?: Dispatchers.IO
) : ViewModel() {

    private val scope = coroutineScope ?: viewModelScope
    private val json = Json { ignoreUnknownKeys = true; isLenient = true; encodeDefaults = true }
    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()
    private val httpClient = customClient ?: OkHttpClient()

    private val _uiState = MutableStateFlow(ApprovalsUiState())
    val uiState: StateFlow<ApprovalsUiState> = _uiState.asStateFlow()

    private val wsScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var approvalsWsClient: HarnessWsClient? = null
    private var orgWsClient: HarnessWsClient? = null

    init {
        checkRoleAndInit()
    }

    fun canManageApprovals(): Boolean {
        val isInstanceAdmin = session.isInstanceAdmin.value
        val orgRole = session.activeOrg.value?.role
        return isInstanceAdmin || orgRole == "owner" || orgRole == "admin"
    }

    fun checkRoleAndInit() {
        val canManage = canManageApprovals()
        _uiState.value = _uiState.value.copy(canManageApprovals = canManage)
        if (canManage) {
            setupRealtimeSubscriptions()
        }
    }

    fun setFilter(filter: ApprovalFilter) {
        _uiState.value = _uiState.value.copy(filter = filter)
    }

    fun setFocusedApprovalId(id: String?) {
        _uiState.value = _uiState.value.copy(focusedApprovalId = id)
        if (id != null && canManageApprovals()) {
            fetchFocusedApproval(id)
        }
    }

    fun dismissBanners() {
        _uiState.value = _uiState.value.copy(
            errorBanner = null,
            conflictBanner = null,
            adminRequiredBanner = null
        )
    }

    fun loadApprovals() {
        val canManage = canManageApprovals()
        _uiState.value = _uiState.value.copy(canManageApprovals = canManage)
        if (!canManage) return

        _uiState.value = _uiState.value.copy(isLoading = true)
        scope.launch {
            try {
                val pending = fetchApprovals(status = "pending")
                val all = fetchApprovals(status = null)
                val resolved = all.filter { it.status != "pending" }

                _uiState.value = _uiState.value.copy(
                    isLoading = false,
                    pendingApprovals = pending,
                    resolvedApprovals = resolved
                )
            } catch (e: Exception) {
                _uiState.value = _uiState.value.copy(
                    isLoading = false,
                    errorBanner = e.message ?: "Failed to load approvals"
                )
            }
        }
    }

    private suspend fun fetchApprovals(status: String?): List<ApprovalView> = withContext(ioDispatcher) {
        val token = (session.sessionState.value as? SessionState.Authenticated)?.token
        val url = if (status != null) "$baseUrl/api/approvals?status=$status" else "$baseUrl/api/approvals"
        val reqBuilder = Request.Builder().url(url).get().header("Origin", baseUrl).header("X-Harness-Mobile", "1")
        if (!token.isNullOrBlank()) reqBuilder.header("Authorization", "Bearer $token")

        httpClient.newCall(reqBuilder.build()).execute().use { resp ->
            if (!resp.isSuccessful) throw IOException("HTTP ${resp.code}: ${resp.message}")
            val body = resp.body?.string() ?: "[]"
            json.decodeFromString<List<ApprovalView>>(body)
        }
    }

    private fun fetchFocusedApproval(id: String) {
        scope.launch {
            try {
                val token = (session.sessionState.value as? SessionState.Authenticated)?.token
                val reqBuilder = Request.Builder().url("$baseUrl/api/approvals/$id").get()
                    .header("Origin", baseUrl).header("X-Harness-Mobile", "1")
                if (!token.isNullOrBlank()) reqBuilder.header("Authorization", "Bearer $token")

                val approval = withContext(ioDispatcher) {
                    httpClient.newCall(reqBuilder.build()).execute().use { resp ->
                        if (resp.isSuccessful) {
                            resp.body?.string()?.let { json.decodeFromString<ApprovalView>(it) }
                        } else null
                    }
                }
                if (approval != null) {
                    val currentPending = _uiState.value.pendingApprovals
                    val currentResolved = _uiState.value.resolvedApprovals
                    if (approval.status == "pending" && currentPending.none { it.id == approval.id }) {
                        _uiState.value = _uiState.value.copy(pendingApprovals = listOf(approval) + currentPending)
                    } else if (approval.status != "pending" && currentResolved.none { it.id == approval.id }) {
                        _uiState.value = _uiState.value.copy(resolvedApprovals = listOf(approval) + currentResolved)
                    }
                }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                _uiState.value = _uiState.value.copy(errorBanner = e.message)
            }
        }
    }

    fun decide(id: String, decision: String) {
        _uiState.value = _uiState.value.copy(decidingId = id, conflictBanner = null, adminRequiredBanner = null)
        scope.launch {
            try {
                val token = (session.sessionState.value as? SessionState.Authenticated)?.token
                val payload = json.encodeToString(DecisionBody(decision))
                val reqBuilder = Request.Builder()
                    .url("$baseUrl/api/approvals/$id")
                    .post(payload.toRequestBody(jsonMediaType))
                    .header("Origin", baseUrl)
                    .header("X-Harness-Mobile", "1")
                if (!token.isNullOrBlank()) reqBuilder.header("Authorization", "Bearer $token")

                val (code, responseBody) = withContext(ioDispatcher) {
                    httpClient.newCall(reqBuilder.build()).execute().use { resp ->
                        resp.code to (resp.body?.string() ?: "")
                    }
                }

                when (code) {
                    200, 201 -> {
                        loadApprovals()
                    }
                    409 -> {
                        _uiState.value = _uiState.value.copy(
                            conflictBanner = "Decision conflict: approval is not pending (already decided)."
                        )
                    }
                    403 -> {
                        val isInstanceAdminReq = responseBody.contains("instance_admin_required")
                        _uiState.value = _uiState.value.copy(
                            adminRequiredBanner = if (isInstanceAdminReq) {
                                "Instance admin required to decide this approval."
                            } else {
                                "Forbidden: insufficient permissions to decide approval."
                            }
                        )
                    }
                    else -> {
                        _uiState.value = _uiState.value.copy(
                            errorBanner = "Failed to decide approval (HTTP $code)"
                        )
                    }
                }
            } catch (e: Exception) {
                _uiState.value = _uiState.value.copy(
                    errorBanner = e.message ?: "Network error during approval decision"
                )
            } finally {
                _uiState.value = _uiState.value.copy(decidingId = null)
            }
        }
    }

    private fun setupRealtimeSubscriptions() {
        val wsBase = baseUrl.replace("http://", "ws://").replace("https://", "wss://")
        val tokenProvider = { (session.sessionState.value as? SessionState.Authenticated)?.token }
        val originProvider = { baseUrl }

        if (session.isInstanceAdmin.value && approvalsWsClient == null) {
            val url = "$wsBase/ws?topic=approvals"
            approvalsWsClient = wsFactory?.invoke(url) ?: HarnessWsClient(
                wsUrl = url,
                tokenProvider = tokenProvider,
                originProvider = originProvider,
                scope = wsScope
            )
            approvalsWsClient?.connect()
            wsScope.launch {
                approvalsWsClient?.messages?.collect { msg ->
                    if (msg is WsMessage.Approval) {
                        loadApprovals()
                    }
                }
            }
        }

        val activeOrgId = session.activeOrg.value?.id
        if (activeOrgId != null && orgWsClient == null) {
            val orgUrl = "$wsBase/ws?topic=org:$activeOrgId"
            orgWsClient = wsFactory?.invoke(orgUrl) ?: HarnessWsClient(
                wsUrl = orgUrl,
                tokenProvider = tokenProvider,
                originProvider = originProvider,
                scope = wsScope
            )
            orgWsClient?.connect()
            wsScope.launch {
                orgWsClient?.messages?.collect { msg ->
                    if (msg is WsMessage.Approval) {
                        loadApprovals()
                    }
                }
            }
        }
    }

    fun remainingSeconds(expiresAt: Long, now: Long = System.currentTimeMillis()): Long {
        return maxOf(0L, (expiresAt - now) / 1000L)
    }

    fun isDangerCountdown(remainingSeconds: Long): Boolean {
        return remainingSeconds in 1..29
    }

    fun isExpired(remainingSeconds: Long): Boolean {
        return remainingSeconds <= 0L
    }

    fun formatCountdown(remainingSeconds: Long): String {
        return if (remainingSeconds <= 0L) {
            "Expired"
        } else {
            val mins = remainingSeconds / 60
            val secs = remainingSeconds % 60
            String.format(Locale.US, "%02d:%02d", mins, secs)
        }
    }

    public override fun onCleared() {
        super.onCleared()
        wsScope.cancel()
        approvalsWsClient?.disconnect()
        orgWsClient?.disconnect()
    }
}
