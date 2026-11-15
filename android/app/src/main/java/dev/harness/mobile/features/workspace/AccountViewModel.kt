package dev.harness.mobile.features.workspace

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.harness.mobile.core.model.DeviceView
import dev.harness.mobile.core.model.MobilePushSubscribeBody
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class AccountState(
    val orgSlug: String = "",
    val prefs: List<PrefView> = emptyList(),
    val targets: List<TargetView> = emptyList(),
    val devices: List<DeviceView> = emptyList(),
    val isLoadingPrefs: Boolean = false,
    val isLoadingTargets: Boolean = false,
    val isLoadingDevices: Boolean = false,
    val isRegisteringPush: Boolean = false,
    val bannerNotice: String? = null,
    val error: String? = null
) {
    fun isPrefEnabled(channel: String, kind: String): Boolean {
        return prefs.find { it.channel == channel && it.kind == kind }?.enabled == true
    }
}

class AccountViewModel(
    private val repository: WorkspaceRepository
) : ViewModel() {

    private val _state = MutableStateFlow(AccountState())
    val state: StateFlow<AccountState> = _state.asStateFlow()

    fun load(orgSlug: String) {
        _state.value = _state.value.copy(orgSlug = orgSlug, error = null)
        loadPrefs(orgSlug)
        loadTargets(orgSlug)
        loadDevices()
    }

    fun loadPrefs(orgSlug: String = _state.value.orgSlug) {
        _state.value = _state.value.copy(isLoadingPrefs = true)
        viewModelScope.launch {
            try {
                val prefs = repository.getNotifyPrefs(orgSlug)
                _state.value = _state.value.copy(prefs = prefs, isLoadingPrefs = false)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                _state.value = _state.value.copy(isLoadingPrefs = false, error = e.message)
            }
        }
    }

    fun togglePref(channel: String, kind: String) {
        val currentEnabled = _state.value.isPrefEnabled(channel, kind)
        val nextEnabled = !currentEnabled
        val oldPrefs = _state.value.prefs
        val updatedPrefs = oldPrefs.filterNot { it.channel == channel && it.kind == kind } +
            PrefView(channel, kind, nextEnabled)
        _state.value = _state.value.copy(prefs = updatedPrefs)

        viewModelScope.launch {
            try {
                val result = repository.updateNotifyPref(
                    _state.value.orgSlug,
                    PrefView(channel, kind, nextEnabled)
                )
                _state.value = _state.value.copy(prefs = result)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                // Rollback on error
                _state.value = _state.value.copy(
                    prefs = oldPrefs,
                    error = e.message ?: "Failed to update notification preference"
                )
            }
        }
    }

    fun loadTargets(orgSlug: String = _state.value.orgSlug) {
        _state.value = _state.value.copy(isLoadingTargets = true)
        viewModelScope.launch {
            try {
                val targets = repository.getTargets(orgSlug)
                _state.value = _state.value.copy(targets = targets, isLoadingTargets = false)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                _state.value = _state.value.copy(isLoadingTargets = false, error = e.message)
            }
        }
    }

    fun registerPush(
        relayUrl: String,
        pushToken: String,
        appId: String = "dev.harness.mobile",
        relaySecret: String? = null
    ) {
        _state.value = _state.value.copy(isRegisteringPush = true, error = null)
        viewModelScope.launch {
            try {
                repository.registerMobilePush(
                    _state.value.orgSlug,
                    MobilePushSubscribeBody(
                        relayUrl = relayUrl,
                        platform = "android",
                        appId = appId,
                        pushToken = pushToken,
                        relaySecret = relaySecret
                    )
                )
                _state.value = _state.value.copy(
                    isRegisteringPush = false,
                    bannerNotice = "Push notifications registered"
                )
                loadTargets(_state.value.orgSlug)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                _state.value = _state.value.copy(isRegisteringPush = false, error = e.message)
            }
        }
    }

    fun loadDevices() {
        _state.value = _state.value.copy(isLoadingDevices = true)
        viewModelScope.launch {
            try {
                val devices = repository.getDevices()
                _state.value = _state.value.copy(devices = devices, isLoadingDevices = false)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                _state.value = _state.value.copy(isLoadingDevices = false, error = e.message)
            }
        }
    }

    fun revokeDevice(deviceId: String) {
        viewModelScope.launch {
            try {
                val ok = repository.revokeDevice(deviceId)
                if (ok) {
                    val updated = _state.value.devices.filterNot { it.id == deviceId }
                    _state.value = _state.value.copy(
                        devices = updated,
                        bannerNotice = "Device revoked successfully"
                    )
                } else {
                    _state.value = _state.value.copy(error = "Failed to revoke device")
                }
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                _state.value = _state.value.copy(error = e.message)
            }
        }
    }

    fun clearBanner() {
        _state.value = _state.value.copy(bannerNotice = null, error = null)
    }
}
