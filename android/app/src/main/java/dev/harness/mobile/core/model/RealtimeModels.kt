package dev.harness.mobile.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
sealed interface WsMessage {
    @Serializable
    @SerialName("event")
    data class Event(
        val runId: String,
        val event: WsEventPayload
    ) : WsMessage

    @Serializable
    @SerialName("run")
    data class Run(
        val run: RunView
    ) : WsMessage

    @Serializable
    @SerialName("approval")
    data class Approval(
        val approval: ApprovalView
    ) : WsMessage

    @Serializable
    @SerialName("task")
    data class Task(
        val projectId: String,
        val taskId: String,
        val kind: String
    ) : WsMessage

    @Serializable
    @SerialName("chat")
    data class Chat(
        val channelId: String,
        val messageId: String,
        val threadRootId: String? = null
    ) : WsMessage

    @Serializable
    @SerialName("dashboard")
    data object Dashboard : WsMessage

    @Serializable
    @SerialName("memory")
    data class Memory(
        val orgId: String
    ) : WsMessage
}

@Serializable
data class WsEventPayload(
    val kind: String,
    val ts: Long? = null
)
