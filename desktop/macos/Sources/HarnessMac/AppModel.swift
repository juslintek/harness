import HarnessKit
import Observation

@MainActor @Observable
final class AppModel {
    let backend = BackendProcess()
    private(set) var client: APIClient?
    private(set) var me: Me?
    private(set) var sessions: [SessionInfo] = []
    private(set) var loading = false
    private(set) var errorMessage: String?

    var orgs: [Org] { me?.orgs ?? [] }

    func boot() async {
        await backend.start()
        if case .running(let port) = backend.state { client = APIClient(port: port) }
    }

    func restartBackend() async {
        // The old cookie belongs to the old process's database; start clean.
        me = nil
        sessions = []
        client = nil
        errorMessage = nil
        backend.stop()
        await boot()
    }

    func refresh() async {
        guard let client else { return }
        loading = true
        errorMessage = nil
        defer { loading = false }
        do {
            async let freshMe = client.me()
            async let freshSessions = client.sessions()
            (me, sessions) = try await (freshMe, freshSessions)
        } catch APIError.unauthorized {
            me = nil
            sessions = []
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func revoke(_ session: SessionInfo) async {
        guard let client else { return }
        do {
            try await client.revokeSession(id: session.id)
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func signOut() async {
        guard let client else { return }
        do {
            try await client.logout()
        } catch APIError.unauthorized {
            // already signed out on the server
        } catch {
            errorMessage = error.localizedDescription
            return
        }
        me = nil
        sessions = []
    }
}
