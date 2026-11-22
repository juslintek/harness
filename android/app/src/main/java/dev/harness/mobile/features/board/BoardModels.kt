package dev.harness.mobile.features.board

import dev.harness.mobile.core.model.OrgView
import dev.harness.mobile.core.model.TaskDepRef
import dev.harness.mobile.core.model.TaskDetail
import dev.harness.mobile.core.model.TaskView
import kotlinx.serialization.Serializable

val BOARD_COLUMNS = listOf(
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "done",
    "blocked",
    "cancelled"
)

fun statusLabel(status: String): String = when (status.lowercase()) {
    "backlog" -> "Backlog"
    "todo" -> "Todo"
    "in_progress" -> "In Progress"
    "in_review" -> "In Review"
    "done" -> "Done"
    "blocked" -> "Blocked"
    "cancelled" -> "Cancelled"
    else -> status.replace('_', ' ').replaceFirstChar { it.uppercase() }
}

@Serializable
data class BoardProject(
    val id: String,
    val orgId: String,
    val key: String,
    val name: String,
    val teamId: String? = null,
    val repo: String? = null
)

@Serializable
data class BoardMember(
    val id: String,
    val handle: String,
    val displayName: String,
    val kind: String = "human"
)

@Serializable
data class OrgDetailResponse(
    val org: OrgView? = null,
    val projects: List<BoardProject> = emptyList(),
    val members: List<BoardMember> = emptyList()
)

data class BoardNotice(
    val taskId: String,
    val message: String
)

sealed interface MoveFailureParsed {
    data class Held(val holderId: String) : MoveFailureParsed
    data class DepsOpen(val open: List<Int>) : MoveFailureParsed
    data class ChildrenOpen(val open: List<Int>) : MoveFailureParsed
    data class Generic(val message: String) : MoveFailureParsed
}

fun formatMoveFailureMessage(failure: MoveFailureParsed, handleOf: ((String) -> String?)? = null): String {
    return when (failure) {
        is MoveFailureParsed.Held -> {
            val handle = handleOf?.invoke(failure.holderId)
            if (handle != null) "Held by @$handle (${failure.holderId})"
            else "Held by ${failure.holderId}"
        }
        is MoveFailureParsed.DepsOpen -> {
            "Waiting on open dependencies: ${failure.open.joinToString(", ") { "#$it" }}"
        }
        is MoveFailureParsed.ChildrenOpen -> {
            "Subtasks open: ${failure.open.joinToString(", ") { "#$it" }}"
        }
        is MoveFailureParsed.Generic -> failure.message
    }
}

sealed interface MoveTaskResult {
    data class Success(val task: TaskView) : MoveTaskResult
    data class Failure(val failure: MoveFailureParsed, val message: String) : MoveTaskResult
}

data class BoardUiState(
    val isLoading: Boolean = false,
    val errorMessage: String? = null,
    val bannerNotice: BoardNotice? = null,
    val projects: List<BoardProject> = emptyList(),
    val selectedProjectId: String? = null,
    val members: List<BoardMember> = emptyList(),
    val selectedAssigneeId: String? = null,
    val tasks: List<TaskView> = emptyList(),
    val deps: List<TaskDepRef> = emptyList(),
    val selectedTaskDetail: TaskDetail? = null,
    val isDetailLoading: Boolean = false,
    val detailError: String? = null
) {
    val subtaskCounts: Map<String, Int>
        get() = tasks.mapNotNull { it.parentId }
            .groupingBy { it }
            .eachCount()

    val depCounts: Map<String, Int>
        get() = deps.groupingBy { it.taskId }
            .eachCount()

    val filteredTasks: List<TaskView>
        get() = if (selectedAssigneeId == null) {
            tasks
        } else {
            tasks.filter { it.assigneeId == selectedAssigneeId }
        }

    val columnTasks: Map<String, List<TaskView>>
        get() = BOARD_COLUMNS.associateWith { status ->
            filteredTasks.filter { it.status == status }
                .sortedWith(compareBy<TaskView> { it.rank }.thenBy { it.number })
        }
}
