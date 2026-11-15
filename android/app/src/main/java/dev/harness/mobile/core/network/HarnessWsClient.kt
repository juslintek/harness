package dev.harness.mobile.core.network

import dev.harness.mobile.core.model.WsMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

sealed interface WsConnectionState {
    data object Disconnected : WsConnectionState
    data object Connecting : WsConnectionState
    data object Connected : WsConnectionState
    data object Revoked : WsConnectionState
}

class HarnessWsClient(
    val wsUrl: String,
    private val tokenProvider: () -> String?,
    private val originProvider: () -> String,
    private val client: OkHttpClient = OkHttpClient(),
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.IO)
) {
    val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
    }

    private val _connectionState = MutableStateFlow<WsConnectionState>(WsConnectionState.Disconnected)
    val connectionState: StateFlow<WsConnectionState> = _connectionState.asStateFlow()

    private val _messages = MutableSharedFlow<WsMessage>(extraBufferCapacity = 64)
    val messages: SharedFlow<WsMessage> = _messages.asSharedFlow()

    private var webSocket: WebSocket? = null
    private var isRunning = false
    private var reconnectJob: Job? = null
    var reconnectAttempts = 0
        private set

    fun connect() {
        if (isRunning || _connectionState.value is WsConnectionState.Revoked) return
        isRunning = true
        initiateConnection()
    }

    fun disconnect() {
        isRunning = false
        reconnectJob?.cancel()
        reconnectJob = null
        webSocket?.close(1000, "Normal closure")
        webSocket = null
        if (_connectionState.value !is WsConnectionState.Revoked) {
            _connectionState.value = WsConnectionState.Disconnected
        }
    }

    fun decodeMessage(text: String): WsMessage? {
        return try {
            json.decodeFromString<WsMessage>(text)
        } catch (_: Exception) {
            null
        }
    }

    fun calculateBackoff(attempt: Int): Long {
        val shift = minOf(attempt, 5)
        val computed = 1000L * (1L shl shift)
        return minOf(30000L, computed)
    }

    private fun initiateConnection() {
        if (!isRunning || _connectionState.value is WsConnectionState.Revoked) return
        _connectionState.value = WsConnectionState.Connecting

        val requestBuilder = Request.Builder()
            .url(wsUrl)
            .header("Origin", originProvider())
            .header("X-Harness-Mobile", "1")

        val token = tokenProvider()
        if (!token.isNullOrBlank()) {
            requestBuilder.header("Authorization", "Bearer $token")
        }

        webSocket = client.newWebSocket(requestBuilder.build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                reconnectAttempts = 0
                _connectionState.value = WsConnectionState.Connected
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = decodeMessage(text)
                if (msg != null) {
                    _messages.tryEmit(msg)
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                handleClose(code)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                handleClose(code)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (response?.code == 401 || response?.code == 4401) {
                    markRevoked()
                    return
                }
                if (isRunning && _connectionState.value !is WsConnectionState.Revoked) {
                    _connectionState.value = WsConnectionState.Disconnected
                    scheduleReconnect()
                }
            }
        })
    }

    fun handleClose(code: Int) {
        if (code == 4401) {
            markRevoked()
            return
        }
        if (isRunning && _connectionState.value !is WsConnectionState.Revoked) {
            _connectionState.value = WsConnectionState.Disconnected
            scheduleReconnect()
        }
    }

    private fun markRevoked() {
        isRunning = false
        reconnectJob?.cancel()
        reconnectJob = null
        webSocket?.cancel()
        webSocket = null
        _connectionState.value = WsConnectionState.Revoked
    }

    private fun scheduleReconnect() {
        if (!isRunning || _connectionState.value is WsConnectionState.Revoked) return
        reconnectJob?.cancel()
        val delayMs = calculateBackoff(reconnectAttempts)
        reconnectAttempts++
        reconnectJob = scope.launch {
            delay(delayMs)
            if (isRunning && _connectionState.value !is WsConnectionState.Revoked) {
                initiateConnection()
            }
        }
    }
}
