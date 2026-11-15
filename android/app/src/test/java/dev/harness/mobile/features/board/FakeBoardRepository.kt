package dev.harness.mobile.features.board

import dev.harness.mobile.core.model.*

class FakeBoardRepository(
    initialTasks: List<TaskView> = emptyList(),
    initialDeps: List<TaskDepRef> = emptyList(),
    initialDetail: TaskDetail? = null,
    val moveResultOverride: ((String, String, String?) -> MoveTaskResult)? = null
) : BoardRepository {

    val tasks = initialTasks.toMutableList()
    val deps = initialDeps.toMutableList()
    var detail = initialDetail ?: if (initialTasks.isNotEmpty()) {
        TaskDetail(task = initialTasks.first())
    } else null

    override suspend fun getOrgDetail(slug: String): OrgDetailResponse {
        return OrgDetailResponse(
            org = OrgView("org_1", slug, "Test Org"),
            projects = listOf(BoardProject("prj_019318894978701388bb69b7f5256006", "org_1", "MOB", "Mobile")),
            members = listOf(BoardMember("mem_019318894978701388bb69b7f5256005", "alice", "Alice Cooper"))
        )
    }

    override suspend fun getProjectTasks(projectId: String, status: String?, assigneeId: String?): List<TaskView> {
        var list = tasks.filter { it.projectId == projectId }
        if (status != null) list = list.filter { it.status == status }
        if (assigneeId != null) list = list.filter { it.assigneeId == assigneeId }
        return list
    }

    override suspend fun getProjectDeps(projectId: String): List<TaskDepRef> = deps

    override suspend fun createTask(projectId: String, body: CreateTaskBody): TaskView {
        val created = TaskView(
            id = "tsk_${System.currentTimeMillis()}",
            orgId = "org_1",
            projectId = projectId,
            number = tasks.size + 1,
            title = body.title,
            description = body.description ?: "",
            status = body.status ?: "todo",
            assigneeId = body.assigneeId,
            parentId = body.parentId,
            estimateMinutes = body.estimateMinutes
        )
        tasks.add(created)
        return created
    }

    override suspend fun moveTask(taskId: String, to: String, beforeId: String?): MoveTaskResult {
        if (moveResultOverride != null) {
            return moveResultOverride.invoke(taskId, to, beforeId)
        }
        val idx = tasks.indexOfFirst { it.id == taskId }
        if (idx == -1) return MoveTaskResult.Failure(MoveFailureParsed.Generic("not_found"), "Task not found")
        val updated = tasks[idx].copy(status = to)
        tasks[idx] = updated
        return MoveTaskResult.Success(updated)
    }

    override suspend fun getTaskDetail(taskId: String): TaskDetail {
        val d = detail
        if (d != null && d.task.id == taskId) return d
        val t = tasks.find { it.id == taskId } ?: TaskView(id = taskId, orgId = "org_1", projectId = "prj_1", number = 0, title = "Task", status = "todo")
        return TaskDetail(task = t)
    }

    override suspend fun patchTask(taskId: String, body: TaskPatchBody): TaskView {
        val idx = tasks.indexOfFirst { it.id == taskId }
        val curr = if (idx != -1) tasks[idx] else detail?.task ?: error("not found")
        val updated = curr.copy(
            title = body.title ?: curr.title,
            description = body.description ?: curr.description,
            estimateMinutes = body.estimateMinutes ?: curr.estimateMinutes,
            assigneeId = body.assigneeId ?: curr.assigneeId
        )
        if (idx != -1) tasks[idx] = updated
        detail = detail?.copy(task = updated)
        return updated
    }

    override suspend fun checkoutTask(taskId: String): MoveTaskResult {
        val idx = tasks.indexOfFirst { it.id == taskId }
        val curr = if (idx != -1) tasks[idx] else detail?.task ?: error("not found")
        val updated = curr.copy(holderId = "mem_019318894978701388bb69b7f5256005")
        if (idx != -1) tasks[idx] = updated
        detail = detail?.copy(task = updated)
        return MoveTaskResult.Success(updated)
    }

    override suspend fun releaseTask(taskId: String): MoveTaskResult {
        val idx = tasks.indexOfFirst { it.id == taskId }
        val curr = if (idx != -1) tasks[idx] else detail?.task ?: error("not found")
        val updated = curr.copy(holderId = null)
        if (idx != -1) tasks[idx] = updated
        detail = detail?.copy(task = updated)
        return MoveTaskResult.Success(updated)
    }

    override suspend fun wakeMember(memberId: String, taskId: String): Boolean = true

    override suspend fun addDep(taskId: String, dependsOn: String): Boolean {
        val d = detail ?: return false
        val newDepTask = TaskView(id = dependsOn, orgId = "org_1", projectId = d.task.projectId, number = 99, title = "Dep Task", status = "todo")
        detail = d.copy(deps = d.deps + newDepTask)
        deps.add(TaskDepRef(taskId, dependsOn))
        return true
    }

    override suspend fun removeDep(taskId: String, dependsOn: String): Boolean {
        val d = detail ?: return false
        detail = d.copy(deps = d.deps.filter { it.id != dependsOn })
        deps.removeAll { it.taskId == taskId && it.dependsOn == dependsOn }
        return true
    }

    override suspend fun addComment(taskId: String, body: String): CommentView {
        val comment = CommentView(
            id = "com_${System.currentTimeMillis()}",
            taskId = taskId,
            body = body,
            createdAt = System.currentTimeMillis()
        )
        val d = detail
        if (d != null && d.task.id == taskId) {
            detail = d.copy(comments = d.comments + comment)
        }
        return comment
    }
}
