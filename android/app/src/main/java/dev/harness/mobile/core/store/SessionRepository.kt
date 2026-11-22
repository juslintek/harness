package dev.harness.mobile.core.store

import dev.harness.mobile.core.crypto.TokenStore
import dev.harness.mobile.core.model.MeResponse
import dev.harness.mobile.core.model.OrgView
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed interface SessionState {
    data object Unauthenticated : SessionState
    data class Authenticated(
        val token: String,
        val me: MeResponse,
        val activeOrg: OrgView?
    ) : SessionState
    data object Revoked : SessionState
}

class SessionRepository(
    private val tokenStore: TokenStore
) {
    private val _sessionState = MutableStateFlow<SessionState>(SessionState.Unauthenticated)
    val sessionState: StateFlow<SessionState> = _sessionState.asStateFlow()

    private val _me = MutableStateFlow<MeResponse?>(null)
    val me: StateFlow<MeResponse?> = _me.asStateFlow()

    private val _activeOrg = MutableStateFlow<OrgView?>(null)
    val activeOrg: StateFlow<OrgView?> = _activeOrg.asStateFlow()

    private val _isInstanceAdmin = MutableStateFlow(false)
    val isInstanceAdmin: StateFlow<Boolean> = _isInstanceAdmin.asStateFlow()

    suspend fun authenticate(token: String, meResponse: MeResponse) {
        tokenStore.saveToken(KEY_MOBILE_TOKEN, token)
        _me.value = meResponse
        _isInstanceAdmin.value = meResponse.user.instanceAdmin

        val currentOrg = _activeOrg.value
        val resolvedOrg = if (currentOrg != null && meResponse.orgs.any { it.id == currentOrg.id }) {
            currentOrg
        } else {
            meResponse.orgs.firstOrNull { it.slug != "personal" } ?: meResponse.orgs.firstOrNull()
        }
        _activeOrg.value = resolvedOrg

        _sessionState.value = SessionState.Authenticated(
            token = token,
            me = meResponse,
            activeOrg = resolvedOrg
        )
    }

    fun updateMe(meResponse: MeResponse) {
        _me.value = meResponse
        _isInstanceAdmin.value = meResponse.user.instanceAdmin

        val currentOrg = _activeOrg.value
        val resolvedOrg = if (currentOrg != null && meResponse.orgs.any { it.id == currentOrg.id }) {
            currentOrg
        } else {
            meResponse.orgs.firstOrNull { it.slug != "personal" } ?: meResponse.orgs.firstOrNull()
        }
        _activeOrg.value = resolvedOrg

        val current = _sessionState.value
        if (current is SessionState.Authenticated) {
            _sessionState.value = current.copy(
                me = meResponse,
                activeOrg = resolvedOrg
            )
        }
    }

    fun selectOrg(orgId: String) {
        val org = _me.value?.orgs?.find { it.id == orgId } ?: return
        _activeOrg.value = org

        val current = _sessionState.value
        if (current is SessionState.Authenticated) {
            _sessionState.value = current.copy(activeOrg = org)
        }
    }

    suspend fun logout() {
        tokenStore.removeToken(KEY_MOBILE_TOKEN)
        _me.value = null
        _activeOrg.value = null
        _isInstanceAdmin.value = false
        _sessionState.value = SessionState.Unauthenticated
    }

    suspend fun markRevoked() {
        tokenStore.removeToken(KEY_MOBILE_TOKEN)
        _me.value = null
        _activeOrg.value = null
        _isInstanceAdmin.value = false
        _sessionState.value = SessionState.Revoked
    }

    suspend fun getStoredToken(): String? {
        return tokenStore.getToken(KEY_MOBILE_TOKEN)
    }

    companion object {
        const val KEY_MOBILE_TOKEN = "harness_mobile_bearer_token"
    }
}
