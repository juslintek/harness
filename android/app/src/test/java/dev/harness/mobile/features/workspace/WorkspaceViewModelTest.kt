package dev.harness.mobile.features.workspace

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
class WorkspaceViewModelTest {

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
    fun testDashboardLoadingAndRangeCalculation() = runTest(testDispatcher) {
        val raw = readFixture("dashboard.json")
        val dash = json.decodeFromString<DashboardFixture>(raw)

        val fakeRepo = FakeWorkspaceRepository(initialDashboard = dash)
        val viewModel = DashboardViewModel(fakeRepo)

        viewModel.load("alice-org", DashboardTimeRange.HOURS_24)
        testDispatcher.scheduler.advanceUntilIdle()

        val state = viewModel.state.value
        assertNotNull(state.dashboard)
        assertEquals(1, state.dashboard?.members?.size)
        assertEquals("alice", state.dashboard?.members?.get(0)?.handle)
        assertEquals(0.45, state.totalSpendUsd, 0.001)
        assertEquals(50000L, state.totalInputTokens)
        assertEquals(12000L, state.totalOutputTokens)
        assertEquals(10, state.totalRuns)
        assertEquals(9, state.totalCompleted)

        val now = System.currentTimeMillis()
        val expected24hSince = DashboardTimeRange.HOURS_24.computeSinceMs(now)
        val actualSince = fakeRepo.lastSinceMsQueried ?: 0L
        assertTrue("Since timestamp must be within 5 seconds of expected 24h", Math.abs(expected24hSince - actualSince) < 5000)

        viewModel.selectRange(DashboardTimeRange.DAYS_7)
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals(DashboardTimeRange.DAYS_7, viewModel.state.value.selectedRange)
        val expected7dSince = DashboardTimeRange.DAYS_7.computeSinceMs(now)
        val actual7dSince = fakeRepo.lastSinceMsQueried ?: 0L
        assertTrue("Since timestamp must be within 5 seconds of expected 7d", Math.abs(expected7dSince - actual7dSince) < 5000)

        viewModel.selectRange(DashboardTimeRange.DAYS_30)
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals(DashboardTimeRange.DAYS_30, viewModel.state.value.selectedRange)
        val expected30dSince = DashboardTimeRange.DAYS_30.computeSinceMs(now)
        val actual30dSince = fakeRepo.lastSinceMsQueried ?: 0L
        assertTrue("Since timestamp must be within 5 seconds of expected 30d", Math.abs(expected30dSince - actual30dSince) < 5000)
    }

    @Test
    fun testWsDashboardNudgeTriggersRefresh() = runTest(testDispatcher) {
        val raw = readFixture("dashboard.json")
        val dash = json.decodeFromString<DashboardFixture>(raw)
        val wsFlow = MutableSharedFlow<WsMessage>()

        val fakeRepo = FakeWorkspaceRepository(initialDashboard = dash)
        val viewModel = DashboardViewModel(fakeRepo, wsFlow = wsFlow)

        viewModel.load("alice-org")
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals(1, viewModel.state.value.dashboard?.members?.size)

        val updatedMember = dash.members[0].copy(costUsd = 1.25)
        fakeRepo.dashboard = dash.copy(members = listOf(updatedMember))

        wsFlow.emit(WsMessage.Dashboard)
        testDispatcher.scheduler.advanceUntilIdle()

        assertEquals(1.25, viewModel.state.value.totalSpendUsd, 0.001)
    }

    @Test
    fun testMemorySearchFacetsAndWikilink() = runTest(testDispatcher) {
        val raw = readFixture("memory.json")
        val memory = json.decodeFromString<MemoryFixture>(raw)
        val note = memory.note ?: error("Missing note")

        val fakeRepo = FakeWorkspaceRepository(
            initialFacets = memory.facets,
            initialNotes = memory.notes,
            initialNoteViews = mapOf(note.id to note),
            initialWrites = memory.writes,
            initialLessons = memory.lessons
        )
        val viewModel = MemoryViewModel(fakeRepo)
        viewModel.load("alice-org")
        testDispatcher.scheduler.advanceUntilIdle()

        assertEquals(2, viewModel.state.value.facets.scopes["global"])
        assertEquals(5, viewModel.state.value.facets.scopes["org"])
        assertEquals(1, viewModel.state.value.notes.size)

        viewModel.search("mobile")
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals(1, viewModel.state.value.notes.size)

        viewModel.search("nonexistent")
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals(0, viewModel.state.value.notes.size)

        viewModel.search("")
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals(1, viewModel.state.value.notes.size)

        viewModel.openNoteDetail(note.id)
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals(note.id, viewModel.state.value.selectedNote?.id)
        assertTrue(viewModel.state.value.selectedNote?.body?.contains("IEEE P1363") == true)

        viewModel.resolveWikilink("Mobile Device Authentication")
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals(note.id, viewModel.state.value.wikilinkResult?.id)
    }

    @Test
    fun testMemoryTypeAndTagFiltering() = runTest(testDispatcher) {
        val raw = readFixture("memory.json")
        val memory = json.decodeFromString<MemoryFixture>(raw)
        val note = memory.notes.first()

        val noteLesson = note.copy(id = "not_lesson", type = "lesson", tags = listOf("security"))
        val fakeRepo = FakeWorkspaceRepository(
            initialNotes = listOf(note, noteLesson)
        )
        val viewModel = MemoryViewModel(fakeRepo)
        viewModel.load("alice-org")
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals(2, viewModel.state.value.notes.size)

        viewModel.setTypeFilter("decision")
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals(1, viewModel.state.value.notes.size)
        assertEquals("decision", viewModel.state.value.notes[0].type)

        viewModel.setTypeFilter(null)
        viewModel.setTagFilter("security")
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals(1, viewModel.state.value.notes.size)
        assertEquals("not_lesson", viewModel.state.value.notes[0].id)
    }

    @Test
    fun testMemoryWsNudgeTriggersRefresh() = runTest(testDispatcher) {
        val raw = readFixture("memory.json")
        val memory = json.decodeFromString<MemoryFixture>(raw)
        val wsFlow = MutableSharedFlow<WsMessage>()

        val fakeRepo = FakeWorkspaceRepository(
            initialNotes = memory.notes
        )
        val viewModel = MemoryViewModel(fakeRepo, wsFlow = wsFlow)
        viewModel.load("alice-org")
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals(1, viewModel.state.value.notes.size)

        val newNote = memory.notes[0].copy(id = "not_new", title = "New Note From WS")
        fakeRepo.notes.add(newNote)

        wsFlow.emit(WsMessage.Memory(orgId = "alice-org"))
        testDispatcher.scheduler.advanceUntilIdle()

        assertEquals(2, viewModel.state.value.notes.size)
    }

    @Test
    fun testMemory409ConflictDraftPreservationAndResolution() = runTest(testDispatcher) {
        val raw = readFixture("memory.json")
        val memory = json.decodeFromString<MemoryFixture>(raw)
        val note = memory.note ?: error("Missing note")

        val fakeRepo = FakeWorkspaceRepository(
            initialFacets = memory.facets,
            initialNotes = memory.notes,
            initialNoteViews = mapOf(note.id to note)
        )
        val viewModel = MemoryViewModel(fakeRepo)
        viewModel.load("alice-org")
        testDispatcher.scheduler.advanceUntilIdle()

        viewModel.openEditNoteEditor(note)
        assertEquals(note.id, viewModel.state.value.editorNoteId)
        assertEquals(note.hash, viewModel.state.value.editorBaseHash)

        val localDraft = "# Modified Mobile Auth\nDraft local modifications."
        viewModel.updateEditorDraft(localDraft)
        assertEquals(localDraft, viewModel.state.value.editorDraftBody)

        val remoteNewHash = "concurrent_hash_9999"
        val remoteBody = "# Remote Updated Auth\nConcurrent remote modifications."
        fakeRepo.noteViews[note.id] = note.copy(hash = remoteNewHash, body = remoteBody)

        viewModel.saveNoteDraft()
        testDispatcher.scheduler.advanceUntilIdle()

        val conflict = viewModel.state.value.conflictState
        assertNotNull("Conflict state must be populated on 409", conflict)
        assertEquals(remoteNewHash, conflict?.remoteHash)
        assertEquals(remoteBody, conflict?.remoteBody)
        assertEquals(localDraft, conflict?.localDraftBody)
        assertEquals(localDraft, viewModel.state.value.editorDraftBody)

        viewModel.resolveConflictOverwrite()
        testDispatcher.scheduler.advanceUntilIdle()

        assertNull(viewModel.state.value.conflictState)
        assertEquals(localDraft, fakeRepo.noteViews[note.id]?.body)
    }

    @Test
    fun testMemory409ConflictReloadRemote() = runTest(testDispatcher) {
        val raw = readFixture("memory.json")
        val memory = json.decodeFromString<MemoryFixture>(raw)
        val note = memory.note ?: error("Missing note")

        val fakeRepo = FakeWorkspaceRepository(
            initialNoteViews = mapOf(note.id to note)
        )
        val viewModel = MemoryViewModel(fakeRepo)
        viewModel.load("alice-org")
        testDispatcher.scheduler.advanceUntilIdle()

        viewModel.openEditNoteEditor(note)
        viewModel.updateEditorDraft("My local changes")

        val remoteNewHash = "remote_hash_abc"
        val remoteBody = "Content from another user"
        fakeRepo.noteViews[note.id] = note.copy(hash = remoteNewHash, body = remoteBody)

        viewModel.saveNoteDraft()
        testDispatcher.scheduler.advanceUntilIdle()

        assertNotNull(viewModel.state.value.conflictState)

        viewModel.resolveConflictReloadRemote()
        testDispatcher.scheduler.advanceUntilIdle()

        assertNull(viewModel.state.value.conflictState)
        assertEquals(remoteBody, viewModel.state.value.editorDraftBody)
        assertEquals(remoteNewHash, viewModel.state.value.editorBaseHash)
    }

    @Test
    fun testWritesRevertAndLessonReview() = runTest(testDispatcher) {
        val raw = readFixture("memory.json")
        val memory = json.decodeFromString<MemoryFixture>(raw)
        val write = memory.writes.first()
        val lesson = memory.lessons.first()

        val fakeRepo = FakeWorkspaceRepository(
            initialWrites = memory.writes,
            initialLessons = memory.lessons,
            initialNoteViews = mapOf(write.noteId to memory.note!!)
        )
        val viewModel = MemoryViewModel(fakeRepo)
        viewModel.load("alice-org")
        testDispatcher.scheduler.advanceUntilIdle()

        assertEquals(1, viewModel.state.value.writes.size)
        assertEquals(1, viewModel.state.value.lessons.size)

        viewModel.revertWrite(write.id)
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals(0, viewModel.state.value.writes.size)
        assertEquals("Write reverted successfully", viewModel.state.value.bannerNotice)

        viewModel.decideLesson(lesson.id, "reject", "Superseded by new RFC")
        testDispatcher.scheduler.advanceUntilIdle()
        val updatedLesson = viewModel.state.value.lessons.find { it.id == lesson.id }
        assertEquals("rejected", updatedLesson?.status)
        assertEquals("Superseded by new RFC", updatedLesson?.reason)
    }

    @Test
    fun testNotification25MatrixToggleAndDeviceRevoke() = runTest(testDispatcher) {
        val rawMe = readFixture("me.json")
        val me = json.decodeFromString<MeResponse>(rawMe)

        val initialPrefs = mutableListOf<PrefView>()
        for (c in NOTIFY_CHANNELS) {
            for (k in NOTIFY_KINDS) {
                initialPrefs.add(PrefView(c, k, enabled = (c == "push" && k == "approval_requested")))
            }
        }
        assertEquals(25, initialPrefs.size)

        val fakeRepo = FakeWorkspaceRepository(
            initialPrefs = initialPrefs,
            initialDevices = me.devices
        )
        val viewModel = AccountViewModel(fakeRepo)
        viewModel.load("alice-org")
        testDispatcher.scheduler.advanceUntilIdle()

        val state = viewModel.state.value
        assertEquals(25, state.prefs.size)
        assertTrue(state.isPrefEnabled("push", "approval_requested"))
        assertFalse(state.isPrefEnabled("email", "dm"))

        viewModel.togglePref("email", "dm")
        testDispatcher.scheduler.advanceUntilIdle()
        assertTrue(viewModel.state.value.isPrefEnabled("email", "dm"))

        viewModel.togglePref("email", "dm")
        testDispatcher.scheduler.advanceUntilIdle()
        assertFalse(viewModel.state.value.isPrefEnabled("email", "dm"))

        assertEquals(1, viewModel.state.value.devices.size)
        val deviceId = me.devices[0].id

        viewModel.revokeDevice(deviceId)
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals(0, viewModel.state.value.devices.size)
        assertEquals("Device revoked successfully", viewModel.state.value.bannerNotice)

        viewModel.registerPush("https://relay.example.com", "push_token_xyz")
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals(1, viewModel.state.value.targets.size)
        assertEquals("Push notifications registered", viewModel.state.value.bannerNotice)
    }
}
