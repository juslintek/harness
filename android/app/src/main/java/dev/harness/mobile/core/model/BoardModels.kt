package dev.harness.mobile.core.model

import kotlinx.serialization.Serializable

@Serializable
data class PersonRef(
    val handle: String,
    val displayName: String,
    val kind: String,
    val id: String? = null
)

@Serializable
data class TaskView(
    val id: String,
    val orgId: String,
    val projectId: String,
    val number: Int,
    val parentId: String? = null,
    val title: String,
    val description: String = "",
    val status: String,
    val rank: Long = 0L,
    val assigneeId: String? = null,
    val holderId: String? = null,
    val assignee: PersonRef? = null,
    val holder: PersonRef? = null,
    val checkedOutAt: Long? = null,
    val estimateMinutes: Int? = null,
    val createdBy: String = "",
    val createdAt: Long = 0L,
    val updatedAt: Long = 0L
)

@Serializable
data class CommentView(
    val id: String,
    val taskId: String,
    val authorId: String? = null,
    val author: PersonRef? = null,
    val body: String,
    val createdAt: Long = 0L
)

@Serializable
data class TaskDetail(
    val task: TaskView,
    val deps: List<TaskView> = emptyList(),
    val subtasks: List<TaskView> = emptyList(),
    val comments: List<CommentView> = emptyList()
)

@Serializable
data class TaskDepRef(
    val taskId: String,
    val dependsOn: String
)

@Serializable
data class BoardTasksFixture(
    val tasks: List<TaskView> = emptyList(),
    val deps: List<TaskDepRef> = emptyList(),
    val detail: TaskDetail? = null
)

@Serializable
data class CreateTaskBody(
    val title: String,
    val description: String? = null,
    val parentId: String? = null,
    val assigneeId: String? = null,
    val estimateMinutes: Int? = null,
    val status: String? = null
)

@Serializable
data class TaskPatchBody(
    val title: String? = null,
    val description: String? = null,
    val estimateMinutes: Int? = null,
    val assigneeId: String? = null
)

@Serializable
data class MoveBody(
    val to: String,
    val beforeId: String? = null
)

@Serializable
data class DepBody(
    val dependsOn: String
)

@Serializable
data class CommentBody(
    val body: String
)

@Serializable
data class MoveFailureHeld(
    val ok: Boolean = false,
    val reason: String = "held",
    val holderId: String
)

@Serializable
data class MoveFailureDepsOpen(
    val ok: Boolean = false,
    val reason: String = "deps_open",
    val open: List<Int> = emptyList()
)

@Serializable
data class MoveFailureChildrenOpen(
    val ok: Boolean = false,
    val reason: String = "children_open",
    val open: List<Int> = emptyList()
)

@Serializable
data class Move409Fixture(
    val held: MoveFailureHeld,
    val depsOpen: MoveFailureDepsOpen,
    val childrenOpen: MoveFailureChildrenOpen
)
