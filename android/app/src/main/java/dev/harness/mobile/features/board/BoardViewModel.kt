package dev.harness.mobile.features.board

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.harness.mobile.core.model.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class BoardViewModel(
    val repository: BoardRepository,
    val wsFlow: Flow<WsMessage>? = null
) : ViewModel() {

    private val _state = MutableStateFlow(BoardUiState())
    val state: StateFlow<BoardUiState> = _state.asStateFlow()

    private var activeOrgSlug: String? = null

    init {
        if (wsFlow != null) {
            viewModelScope.launch {
                wsFlow.collect { msg -> handleWsMessage(msg) }
            }
        }
    }

    fun handleWsMessage(msg: WsMessage) {
        if (msg is WsMessage.Task) {
            val currentProject = _state.value.selectedProjectId
            if (currentProject == null || msg.projectId == currentProject) {
                refresh()
            }
        }
    }

    fun load(orgSlug: String, initialProjectId: String? = null) {
        activeOrgSlug = orgSlug
        _state.value = _state.value.copy(isLoading = true, errorMessage = null)
        viewModelScope.launch {
            try {
                val orgDetail = repository.getOrgDetail(orgSlug)
                val projects = orgDetail.projects
                val selectedProj = initialProjectId
                    ?: projects.find { it.id == _state.value.selectedProjectId }?.id
                    ?: projects.firstOrNull()?.id

                _state.value = _state.value.copy(
                    projects = projects,
                    members = orgDetail.members,
                    selectedProjectId = selectedProj,
                    isLoading = false
                )
                if (selectedProj != null) loadProjectData(selectedProj)
            } catch (e: Exception) {
                _state.value = _state.value.copy(
                    isLoading = false,
                    errorMessage = e.message ?: "Failed to load projects"
                )
            }
        }
    }

    fun selectProject(projectId: String) {
        if (_state.value.selectedProjectId == projectId) return
        _state.value = _state.value.copy(
            selectedProjectId = projectId,
            tasks = emptyList(),
            deps = emptyList(),
            bannerNotice = null
        )
        loadProjectData(projectId)
    }

    fun filterAssignee(assigneeId: String?) {
        _state.value = _state.value.copy(selectedAssigneeId = assigneeId)
    }

    fun refresh() {
        val projectId = _state.value.selectedProjectId ?: return
        loadProjectData(projectId)
    }

    private fun loadProjectData(projectId: String) {
        viewModelScope.launch {
            try {
                val tasks = repository.getProjectTasks(projectId)
                val deps = repository.getProjectDeps(projectId)
                _state.value = _state.value.copy(tasks = tasks, deps = deps, errorMessage = null)
            } catch (e: Exception) {
                _state.value = _state.value.copy(errorMessage = e.message ?: "Failed to load tasks")
            }
        }
    }

    private fun updateTaskInState(taskId: String, updated: TaskView) {
        val updatedTasks = _state.value.tasks.map { if (it.id == taskId) updated else it }
        val currentDetail = _state.value.selectedTaskDetail
        val newDetail = if (currentDetail?.task?.id == taskId) currentDetail.copy(task = updated) else currentDetail
        _state.value = _state.value.copy(tasks = updatedTasks, selectedTaskDetail = newDetail)
    }

    fun moveTask(taskId: String, to: String, beforeId: String? = null) {
        val currentTasks = _state.value.tasks
        val target = currentTasks.find { it.id == taskId } ?: return
        if (target.status == to && beforeId == null) return

        val tasksInToColumn = currentTasks.filter { it.status == to && it.id != taskId }.sortedBy { it.rank }
        val newRank: Long = if (beforeId != null) {
            val beforeTask = currentTasks.find { it.id == beforeId }
            val index = tasksInToColumn.indexOfFirst { it.id == beforeId }
            if (beforeTask != null && index > 0) {
                (tasksInToColumn[index - 1].rank + beforeTask.rank) / 2L
            } else if (beforeTask != null) {
                maxOf(0L, beforeTask.rank - 500L)
            } else {
                (tasksInToColumn.maxOfOrNull { it.rank } ?: 0L) + 1000L
            }
        } else {
            (tasksInToColumn.maxOfOrNull { it.rank } ?: 0L) + 1000L
        }

        // Optimistic update
        val optimisticTasks = currentTasks.map {
            if (it.id == taskId) it.copy(status = to, rank = newRank) else it
        }
        _state.value = _state.value.copy(tasks = optimisticTasks, bannerNotice = null)

        viewModelScope.launch {
            when (val result = repository.moveTask(taskId, to, beforeId)) {
                is MoveTaskResult.Success -> updateTaskInState(taskId, result.task)
                is MoveTaskResult.Failure -> {
                    // Exact rollback to prior column and rank state
                    _state.value = _state.value.copy(
                        tasks = currentTasks,
                        bannerNotice = BoardNotice(taskId, result.message)
                    )
                }
            }
        }
    }

    fun createTask(
        title: String,
        description: String? = null,
        assigneeId: String? = null,
        estimateMinutes: Int? = null,
        status: String? = null,
        parentId: String? = null
    ) {
        val projectId = _state.value.selectedProjectId ?: return
        viewModelScope.launch {
            try {
                val body = CreateTaskBody(
                    title = title,
                    description = description,
                    parentId = parentId,
                    assigneeId = assigneeId,
                    estimateMinutes = estimateMinutes,
                    status = status ?: "todo"
                )
                val created = repository.createTask(projectId, body)
                _state.value = _state.value.copy(tasks = _state.value.tasks + created)
                if (parentId != null && _state.value.selectedTaskDetail?.task?.id == parentId) {
                    openTaskDetail(parentId)
                }
            } catch (e: Exception) {
                _state.value = _state.value.copy(errorMessage = e.message ?: "Failed to create task")
            }
        }
    }

    fun openTaskDetail(taskId: String) {
        _state.value = _state.value.copy(isDetailLoading = true, detailError = null)
        viewModelScope.launch {
            try {
                val detail = repository.getTaskDetail(taskId)
                _state.value = _state.value.copy(selectedTaskDetail = detail, isDetailLoading = false)
            } catch (e: Exception) {
                _state.value = _state.value.copy(
                    isDetailLoading = false,
                    detailError = e.message ?: "Failed to load task detail"
                )
            }
        }
    }

    fun closeTaskDetail() {
        _state.value = _state.value.copy(selectedTaskDetail = null, detailError = null, isDetailLoading = false)
    }

    fun patchTask(
        taskId: String,
        title: String? = null,
        description: String? = null,
        estimateMinutes: Int? = null,
        assigneeId: String? = null
    ) {
        viewModelScope.launch {
            try {
                val body = TaskPatchBody(title, description, estimateMinutes, assigneeId)
                val updated = repository.patchTask(taskId, body)
                updateTaskInState(taskId, updated)
            } catch (e: Exception) {
                _state.value = _state.value.copy(detailError = e.message ?: "Failed to patch task")
            }
        }
    }

    private fun mutateTask(taskId: String, block: suspend () -> MoveTaskResult) {
        viewModelScope.launch {
            when (val res = block()) {
                is MoveTaskResult.Success -> updateTaskInState(taskId, res.task)
                is MoveTaskResult.Failure -> _state.value = _state.value.copy(detailError = res.message)
            }
        }
    }

    fun checkoutTask(taskId: String) = mutateTask(taskId) { repository.checkoutTask(taskId) }

    fun releaseTask(taskId: String) = mutateTask(taskId) { repository.releaseTask(taskId) }

    fun wakeMember(memberId: String, taskId: String) {
        viewModelScope.launch {
            try {
                repository.wakeMember(memberId, taskId)
            } catch (e: Exception) {
                _state.value = _state.value.copy(detailError = e.message ?: "Failed to wake member")
            }
        }
    }

    private fun mutateDep(taskId: String, block: suspend () -> Unit) {
        viewModelScope.launch {
            try {
                block()
                openTaskDetail(taskId)
                _state.value.selectedProjectId?.let {
                    _state.value = _state.value.copy(deps = repository.getProjectDeps(it))
                }
            } catch (e: Exception) {
                _state.value = _state.value.copy(detailError = e.message ?: "Dependency update failed")
            }
        }
    }

    fun addDependency(taskId: String, dependsOnTaskId: String) =
        mutateDep(taskId) { repository.addDep(taskId, dependsOnTaskId) }

    fun removeDependency(taskId: String, dependsOnTaskId: String) =
        mutateDep(taskId) { repository.removeDep(taskId, dependsOnTaskId) }

    fun addComment(taskId: String, body: String) {
        if (body.isBlank()) return
        viewModelScope.launch {
            try {
                val comment = repository.addComment(taskId, body.trim())
                val currentDetail = _state.value.selectedTaskDetail
                if (currentDetail?.task?.id == taskId) {
                    _state.value = _state.value.copy(
                        selectedTaskDetail = currentDetail.copy(comments = currentDetail.comments + comment)
                    )
                }
            } catch (e: Exception) {
                _state.value = _state.value.copy(detailError = e.message ?: "Failed to add comment")
            }
        }
    }

    fun dismissBanner() {
        _state.value = _state.value.copy(bannerNotice = null)
    }
}
