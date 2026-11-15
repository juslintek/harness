import Foundation
import Observation

@Observable
@MainActor
public final class MemoryStore {
    public var notes: [MemoryNoteSummary] = []
    public var facets: MemoryFacets = MemoryFacets()
    public var searchQuery: String = ""
    public var selectedScope: String?
    public var selectedType: String?
    public var selectedTag: String?
    public var selectedSource: String?

    public var selectedNote: MemoryNoteDetail?
    public var localDraft: String = ""
    public var backlinks: [MemoryNoteSummary] = []
    public var writes: [MemoryWrite] = []
    public var lessons: [MemoryLesson] = []

    public var conflictState: MemoryConflictState?
    public var isConflictPresented: Bool = false
    public var wasLastSaveRedacted: Bool = false
    public var isLoading: Bool = false
    public var errorMessage: String?

    public let apiClient: HarnessAPIClient?
    public let orgSlug: String
    public let orgId: String?
    public let isOrgAdmin: Bool
    public let isInstanceAdmin: Bool

    public var wsClient: HarnessWSClient?
    private var wsTask: Task<Void, Never>?

    public init(
        apiClient: HarnessAPIClient? = nil,
        orgSlug: String,
        orgId: String? = nil,
        isOrgAdmin: Bool = false,
        isInstanceAdmin: Bool = false
    ) {
        self.apiClient = apiClient
        self.orgSlug = orgSlug
        self.orgId = orgId
        self.isOrgAdmin = isOrgAdmin
        self.isInstanceAdmin = isInstanceAdmin
    }

    public func loadFacets() async {
        guard let apiClient else { return }
        do {
            let req = try apiClient.buildRequest(path: "/api/orgs/\(orgSlug)/memory/facets")
            self.facets = try await apiClient.send(req)
        } catch {
            self.errorMessage = error.localizedDescription
        }
    }

    public func loadNotes() async {
        guard let apiClient else { return }
        isLoading = true
        defer { isLoading = false }

        var items: [String] = []
        if !searchQuery.isEmpty, let enc = searchQuery.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
            items.append("q=\(enc)")
        }
        if let selectedScope { items.append("scope=\(selectedScope)") }
        if let selectedType { items.append("type=\(selectedType)") }
        if let selectedTag, let enc = selectedTag.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
            items.append("tag=\(enc)")
        }
        if let selectedSource, let enc = selectedSource.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
            items.append("source=\(enc)")
        }

        let query = items.isEmpty ? "" : "?\(items.joined(separator: "&"))"
        do {
            let req = try apiClient.buildRequest(path: "/api/orgs/\(orgSlug)/memory/notes\(query)")
            self.notes = try await apiClient.send(req)
        } catch {
            self.errorMessage = error.localizedDescription
        }
    }

    public func loadNoteDetail(id: String) async {
        guard let apiClient else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let req = try apiClient.buildRequest(path: "/api/orgs/\(orgSlug)/memory/notes/\(id)")
            let detail: MemoryNoteDetail = try await apiClient.send(req)
            self.selectedNote = detail
            self.localDraft = detail.body
            self.wasLastSaveRedacted = false
            self.conflictState = nil
            self.isConflictPresented = false
            await loadBacklinks(id: id)
        } catch {
            self.errorMessage = error.localizedDescription
        }
    }

    public func loadBacklinks(id: String) async {
        guard let apiClient else { return }
        do {
            let req = try apiClient.buildRequest(path: "/api/orgs/\(orgSlug)/memory/notes/\(id)/backlinks")
            self.backlinks = try await apiClient.send(req)
        } catch {
            self.backlinks = []
        }
    }

    public func resolveWikilink(sourceNoteId: String, target: String) async -> MemoryNoteSummary? {
        guard let apiClient,
              let enc = target.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else { return nil }
        do {
            let req = try apiClient.buildRequest(path: "/api/orgs/\(orgSlug)/memory/notes/\(sourceNoteId)/link?target=\(enc)")
            return try await apiClient.send(req)
        } catch {
            return nil
        }
    }

    public func saveNote(
        id: String,
        body: String,
        baseHash: String,
        type: String? = nil,
        tags: [String]? = nil
    ) async throws {
        guard let apiClient else { return }
        isLoading = true
        defer { isLoading = false }

        self.localDraft = body
        let updateReq = MemoryUpdateNoteRequest(baseHash: baseHash, body: body, type: type, tags: tags)
        let bodyData = try JSONEncoder().encode(updateReq)
        let req = try apiClient.buildRequest(
            path: "/api/orgs/\(orgSlug)/memory/notes/\(id)",
            method: "PUT",
            body: bodyData
        )

        do {
            let env: MemoryWriteEnvelope = try await apiClient.send(req)
            self.selectedNote = env.note
            self.localDraft = env.note.body
            self.wasLastSaveRedacted = env.redacted
            self.conflictState = nil
            self.isConflictPresented = false
            await loadNotes()
        } catch HarnessAPIError.httpError(let statusCode, let message) where statusCode == 409 {
            var conflictHash = ""
            if let data = message.data(using: .utf8),
               let parsed = try? JSONDecoder().decode(MemoryConflict409.self, from: data) {
                conflictHash = parsed.hash
            }

            let remoteReq = try apiClient.buildRequest(path: "/api/orgs/\(orgSlug)/memory/notes/\(id)")
            if let latest: MemoryNoteDetail = try? await apiClient.send(remoteReq) {
                let finalConflictHash = conflictHash.isEmpty ? latest.hash : conflictHash
                self.conflictState = MemoryConflictState(
                    latestRemote: latest,
                    localDraft: self.localDraft,
                    conflictHash: finalConflictHash
                )
                self.isConflictPresented = true
            }
        } catch {
            self.errorMessage = error.localizedDescription
            throw error
        }
    }

    public func resolveConflictWithDraftOverwrite(id: String, type: String? = nil, tags: [String]? = nil) async throws {
        guard let conflict = conflictState else { return }
        let newBaseHash = conflict.latestRemote.hash.isEmpty ? conflict.conflictHash : conflict.latestRemote.hash
        try await saveNote(
            id: id,
            body: self.localDraft,
            baseHash: newBaseHash,
            type: type ?? conflict.latestRemote.type,
            tags: tags ?? conflict.latestRemote.tags
        )
    }

    public func resolveConflictWithRemoteReload() {
        guard let conflict = conflictState else { return }
        self.selectedNote = conflict.latestRemote
        self.localDraft = conflict.latestRemote.body
        self.conflictState = nil
        self.isConflictPresented = false
    }

    public func createNote(scope: String, rel: String, body: String, type: String? = nil, tags: [String]? = nil) async throws {
        guard let apiClient else { return }
        isLoading = true
        defer { isLoading = false }

        let createReq = MemoryCreateNoteRequest(scope: scope, rel: rel, body: body, type: type, tags: tags)
        let bodyData = try JSONEncoder().encode(createReq)
        let req = try apiClient.buildRequest(path: "/api/orgs/\(orgSlug)/memory/notes", method: "POST", body: bodyData)
        let env: MemoryWriteEnvelope = try await apiClient.send(req)
        self.selectedNote = env.note
        self.localDraft = env.note.body
        self.wasLastSaveRedacted = env.redacted
        await loadNotes()
        await loadFacets()
    }

    public func deleteNote(id: String, baseHash: String) async throws {
        guard let apiClient else { return }
        isLoading = true
        defer { isLoading = false }

        let req = try apiClient.buildRequest(path: "/api/orgs/\(orgSlug)/memory/notes/\(id)?baseHash=\(baseHash)", method: "DELETE")
        let _: [String: Bool] = try await apiClient.send(req)
        self.selectedNote = nil
        self.localDraft = ""
        await loadNotes()
        await loadFacets()
    }

    public func loadWrites(agentsOnly: Bool = false) async {
        guard let apiClient else { return }
        let flag = agentsOnly ? "1" : "0"
        do {
            let req = try apiClient.buildRequest(path: "/api/orgs/\(orgSlug)/memory/writes?agentsOnly=\(flag)")
            self.writes = try await apiClient.send(req)
        } catch {
            self.errorMessage = error.localizedDescription
        }
    }

    public func revertWrite(id: String) async throws {
        guard let apiClient else { return }
        let req = try apiClient.buildRequest(path: "/api/orgs/\(orgSlug)/memory/writes/\(id)/revert", method: "POST")
        let _: MemoryWriteResult = try await apiClient.send(req)
        await loadWrites()
        await loadNotes()
    }

    public func loadLessons(status: String = "pending") async {
        guard let apiClient else { return }
        do {
            let req = try apiClient.buildRequest(path: "/api/orgs/\(orgSlug)/memory/lessons?status=\(status)")
            self.lessons = try await apiClient.send(req)
        } catch {
            self.errorMessage = error.localizedDescription
        }
    }

    public func decideLesson(id: String, decision: String, reason: String, body: String? = nil) async throws {
        guard let apiClient, isOrgAdmin || isInstanceAdmin else { return }
        let decReq = MemoryLessonDecisionRequest(decision: decision, reason: reason, body: body)
        let bodyData = try JSONEncoder().encode(decReq)
        let req = try apiClient.buildRequest(path: "/api/orgs/\(orgSlug)/memory/lessons/\(id)", method: "POST", body: bodyData)
        let _: MemoryLesson = try await apiClient.send(req)
        await loadLessons()
    }

    public func subscribeToRealtime() {
        guard let apiClient, let orgId, !orgId.isEmpty else { return }
        wsTask?.cancel()
        let ws = HarnessWSClient(origin: apiClient.origin, topic: "org:\(orgId)", tokenProvider: apiClient.tokenProvider)
        self.wsClient = ws
        wsTask = Task { [weak self] in
            for await message in ws.connect() {
                guard let self else { break }
                if case .memory = message {
                    await self.loadNotes()
                    await self.loadFacets()
                }
            }
        }
    }

    public func stopRealtime() {
        wsTask?.cancel()
        wsTask = nil
        Task { [wsClient] in await wsClient?.disconnect() }
    }
}
