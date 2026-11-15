package dev.harness.mobile.features.board

import dev.harness.mobile.core.model.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.File

@OptIn(ExperimentalCoroutinesApi::class)
class BoardViewModelTest {

    private val testDispatcher = StandardTestDispatcher()
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    private fun getFixturesDir(): File {
        val candidates = listOf(
            File("../../contract/mobile-fixtures"),
            File("../contract/mobile-fixtures"),
            File("contract/mobile-fixtures"),
            File("../../../contract/mobile-fixtures")
        )
        return candidates.firstOrNull { it.exists() && it.isDirectory }
            ?: error("Could not find contract/mobile-fixtures directory.")
    }

    private fun readFixture(fileName: String): String {
        val file = File(getFixturesDir(), fileName)
        assertTrue("Fixture file must exist: ${file.absolutePath}", file.exists())
        return file.readText()
    }

    @Before
    fun setUp() = Dispatchers.setMain(testDispatcher)

    @After
    fun tearDown() = Dispatchers.resetMain()

    @Test
    fun testColumnGroupingAndRankSortingFromFixture() = runTest(testDispatcher) {
        val fixtureJson = readFixture("board-tasks.json")
        val boardFixture = json.decodeFromString<BoardTasksFixture>(fixtureJson)

        val task1 = boardFixture.tasks[0]
        val task2 = task1.copy(id = "tsk_2", number = 2, rank = 3000, title = "Task 2")
        val task3 = task1.copy(id = "tsk_3", number = 3, rank = 500, title = "Task 3")
        val taskTodo = task1.copy(id = "tsk_todo", number = 4, status = "todo", rank = 100)
        val allTasks = listOf(task1, task2, task3, taskTodo)

        val fakeRepo = FakeBoardRepository(initialTasks = allTasks, initialDeps = boardFixture.deps)
        val viewModel = BoardViewModel(fakeRepo)
        viewModel.load("test-org", "prj_019318894978701388bb69b7f5256006")
        testDispatcher.scheduler.advanceUntilIdle()

        val state = viewModel.state.value
        assertEquals(4, state.tasks.size)

        // Verify grouping into 7 statuses
        val columns = state.columnTasks
        assertEquals(7, columns.size)
        BOARD_COLUMNS.forEach { col -> assertTrue(columns.containsKey(col)) }

        // todo column has taskTodo
        assertEquals(1, columns["todo"]?.size)
        assertEquals("tsk_todo", columns["todo"]?.get(0)?.id)

        // in_progress column sorted by rank ascending (500 -> 1000 -> 3000)
        val inProgressTasks = columns["in_progress"] ?: emptyList()
        assertEquals(3, inProgressTasks.size)
        assertEquals("tsk_3", inProgressTasks[0].id)
        assertEquals(500L, inProgressTasks[0].rank)
        assertEquals(task1.id, inProgressTasks[1].id)
        assertEquals(1000L, inProgressTasks[1].rank)
        assertEquals("tsk_2", inProgressTasks[2].id)
        assertEquals(3000L, inProgressTasks[2].rank)

        // Test assignee filter
        viewModel.filterAssignee("mem_019318894978701388bb69b7f5256005")
        assertEquals(4, viewModel.state.value.filteredTasks.size)
        viewModel.filterAssignee("other_mem")
        assertEquals(0, viewModel.state.value.filteredTasks.size)
        viewModel.filterAssignee(null)
        assertEquals(4, viewModel.state.value.filteredTasks.size)
    }

    @Test
    fun testOptimisticMoveSuccess() = runTest(testDispatcher) {
        val task = TaskView(
            id = "tsk_move_1", orgId = "org_1", projectId = "prj_1",
            number = 10, title = "Task To Move", status = "todo", rank = 1000L
        )
        val viewModel = BoardViewModel(FakeBoardRepository(initialTasks = listOf(task)))
        viewModel.load("org-slug", "prj_1")
        testDispatcher.scheduler.advanceUntilIdle()

        // Move to in_progress
        viewModel.moveTask("tsk_move_1", "in_progress")

        // Immediately check optimistic state
        val optimisticTask = viewModel.state.value.tasks.find { it.id == "tsk_move_1" }
        assertNotNull(optimisticTask)
        assertEquals("in_progress", optimisticTask?.status)
        assertNull(viewModel.state.value.bannerNotice)

        testDispatcher.scheduler.advanceUntilIdle()

        val finalTask = viewModel.state.value.tasks.find { it.id == "tsk_move_1" }
        assertEquals("in_progress", finalTask?.status)
        assertNull(viewModel.state.value.bannerNotice)
    }

    private fun testMove409Scenario(
        failure: MoveFailureParsed,
        to: String,
        expectedSubstrings: List<String>
    ) = runTest(testDispatcher) {
        val task = TaskView(
            id = "tsk_409", orgId = "org_1", projectId = "prj_1", number = 10,
            title = "409 Task", status = if (to == "done") "in_progress" else "todo", rank = 1000L
        )
        val fakeRepo = FakeBoardRepository(
            initialTasks = listOf(task),
            moveResultOverride = { _, _, _ ->
                MoveTaskResult.Failure(failure, formatMoveFailureMessage(failure))
            }
        )
        val viewModel = BoardViewModel(fakeRepo)
        viewModel.load("org-slug", "prj_1")
        testDispatcher.scheduler.advanceUntilIdle()

        viewModel.moveTask("tsk_409", to)
        assertEquals(to, viewModel.state.value.tasks.find { it.id == "tsk_409" }?.status)

        testDispatcher.scheduler.advanceUntilIdle()

        val rolledBack = viewModel.state.value.tasks.find { it.id == "tsk_409" }
        assertEquals(if (to == "done") "in_progress" else "todo", rolledBack?.status)
        assertEquals(1000L, rolledBack?.rank)

        val notice = viewModel.state.value.bannerNotice
        assertNotNull("Banner notice must be exposed on 409", notice)
        assertEquals("tsk_409", notice?.taskId)
        expectedSubstrings.forEach {
            assertTrue("Notice must contain '$it', was: ${notice?.message}", notice?.message?.contains(it) == true)
        }
    }

    @Test
    fun testMove409HeldRollbackAndBanner() {
        val move409Fixture = json.decodeFromString<Move409Fixture>(readFixture("move-409.json"))
        testMove409Scenario(
            MoveFailureParsed.Held(move409Fixture.held.holderId),
            "in_progress",
            listOf("mem_019318894978701388bb69b7f5256005")
        )
    }

    @Test
    fun testMove409DepsOpenRollbackAndBanner() {
        val move409Fixture = json.decodeFromString<Move409Fixture>(readFixture("move-409.json"))
        testMove409Scenario(
            MoveFailureParsed.DepsOpen(move409Fixture.depsOpen.open),
            "done",
            listOf("#42", "#43")
        )
    }

    @Test
    fun testMove409ChildrenOpenRollbackAndBanner() {
        val move409Fixture = json.decodeFromString<Move409Fixture>(readFixture("move-409.json"))
        testMove409Scenario(
            MoveFailureParsed.ChildrenOpen(move409Fixture.childrenOpen.open),
            "done",
            listOf("#44")
        )
    }

    @Test
    fun testTaskDetailPatchCheckoutReleaseDepsAndComments() = runTest(testDispatcher) {
        val fixtureJson = readFixture("board-tasks.json")
        val boardFixture = json.decodeFromString<BoardTasksFixture>(fixtureJson)
        val initialDetail = boardFixture.detail ?: error("Fixture detail missing")

        val fakeRepo = FakeBoardRepository(
            initialTasks = boardFixture.tasks,
            initialDeps = boardFixture.deps,
            initialDetail = initialDetail
        )

        val viewModel = BoardViewModel(fakeRepo)
        viewModel.load("test-org", "prj_019318894978701388bb69b7f5256006")
        testDispatcher.scheduler.advanceUntilIdle()

        // Open detail
        viewModel.openTaskDetail(initialDetail.task.id)
        testDispatcher.scheduler.advanceUntilIdle()
        assertNotNull(viewModel.state.value.selectedTaskDetail)
        assertEquals("Setup Mobile Fixtures", viewModel.state.value.selectedTaskDetail?.task?.title)

        // Patch task
        viewModel.patchTask(
            taskId = initialDetail.task.id,
            title = "Updated Fixtures",
            description = "New desc",
            estimateMinutes = 120,
            assigneeId = "mem_019318894978701388bb69b7f5256005"
        )
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals("Updated Fixtures", viewModel.state.value.selectedTaskDetail?.task?.title)
        assertEquals("New desc", viewModel.state.value.selectedTaskDetail?.task?.description)
        assertEquals(120, viewModel.state.value.selectedTaskDetail?.task?.estimateMinutes)

        // Checkout task
        viewModel.checkoutTask(initialDetail.task.id)
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals("mem_019318894978701388bb69b7f5256005", viewModel.state.value.selectedTaskDetail?.task?.holderId)

        // Release task
        viewModel.releaseTask(initialDetail.task.id)
        testDispatcher.scheduler.advanceUntilIdle()
        assertNull(viewModel.state.value.selectedTaskDetail?.task?.holderId)

        // Add dependency
        viewModel.addDependency(initialDetail.task.id, "tsk_new_dep")
        testDispatcher.scheduler.advanceUntilIdle()
        assertTrue(viewModel.state.value.selectedTaskDetail?.deps?.any { it.id == "tsk_new_dep" } == true)

        // Remove dependency
        viewModel.removeDependency(initialDetail.task.id, "tsk_new_dep")
        testDispatcher.scheduler.advanceUntilIdle()
        assertFalse(viewModel.state.value.selectedTaskDetail?.deps?.any { it.id == "tsk_new_dep" } == true)

        // Add comment
        viewModel.addComment(initialDetail.task.id, "Brand new test comment")
        testDispatcher.scheduler.advanceUntilIdle()
        val comments = viewModel.state.value.selectedTaskDetail?.comments ?: emptyList()
        assertTrue(comments.any { it.body == "Brand new test comment" })
    }

    @Test
    fun testWsTaskNudgeTriggersRefresh() = runTest(testDispatcher) {
        val wsFlow = MutableSharedFlow<WsMessage>()
        val fakeRepo = FakeBoardRepository(
            initialTasks = listOf(
                TaskView(
                    id = "tsk_ws", orgId = "org_1", projectId = "prj_1",
                    number = 1, title = "Initial WS Task", status = "todo"
                )
            )
        )

        val viewModel = BoardViewModel(fakeRepo, wsFlow = wsFlow)
        viewModel.load("org-slug", "prj_1")
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals(1, viewModel.state.value.tasks.size)

        fakeRepo.tasks.add(
            TaskView(
                id = "tsk_ws_2", orgId = "org_1", projectId = "prj_1",
                number = 2, title = "Added WS Task", status = "in_progress"
            )
        )

        wsFlow.emit(WsMessage.Task(projectId = "prj_1", taskId = "tsk_ws_2", kind = "created"))
        testDispatcher.scheduler.advanceUntilIdle()

        assertEquals(2, viewModel.state.value.tasks.size)
    }
}
