import Foundation
import Observation

@Observable
@MainActor
public final class AccountStore {
    public var prefs: [NotificationPref] = []
    public var targets: [NotificationTarget] = []
    public var devices: [MobileDevice] = []
    public var isLoading: Bool = false
    public var errorMessage: String?

    public let apiClient: HarnessAPIClient?
    public let orgSlug: String
    public let sessionStore: AppSessionStore?

    public init(
        apiClient: HarnessAPIClient? = nil,
        orgSlug: String,
        sessionStore: AppSessionStore? = nil
    ) {
        self.apiClient = apiClient
        self.orgSlug = orgSlug
        self.sessionStore = sessionStore
    }

    public func isEnabled(channel: NotificationChannel, kind: NotificationKind) -> Bool {
        prefs.first(where: { $0.channel == channel && $0.kind == kind })?.enabled ?? false
    }

    public func loadPrefs() async {
        guard let apiClient else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let req = try apiClient.buildRequest(path: "/api/notify/prefs?org=\(orgSlug)")
            self.prefs = try await apiClient.send(req)
        } catch {
            self.errorMessage = error.localizedDescription
        }
    }

    public func togglePref(channel: NotificationChannel, kind: NotificationKind) async {
        guard let apiClient else { return }
        let current = isEnabled(channel: channel, kind: kind)
        let nextEnabled = !current

        // Optimistic update
        var updated = prefs
        if let idx = updated.firstIndex(where: { $0.channel == channel && $0.kind == kind }) {
            updated[idx].enabled = nextEnabled
        } else {
            updated.append(NotificationPref(channel: channel, kind: kind, enabled: nextEnabled))
        }
        self.prefs = updated

        let bodyPref = NotificationPref(channel: channel, kind: kind, enabled: nextEnabled)
        do {
            let bodyData = try JSONEncoder().encode(bodyPref)
            let req = try apiClient.buildRequest(
                path: "/api/notify/prefs?org=\(orgSlug)",
                method: "PUT",
                body: bodyData
            )
            let res: [NotificationPref] = try await apiClient.send(req)
            self.prefs = res
        } catch {
            // Roll back on failure
            if let idx = self.prefs.firstIndex(where: { $0.channel == channel && $0.kind == kind }) {
                self.prefs[idx].enabled = current
            }
            self.errorMessage = error.localizedDescription
        }
    }

    public func loadTargets() async {
        guard let apiClient else { return }
        do {
            let req = try apiClient.buildRequest(path: "/api/notify/targets?org=\(orgSlug)")
            self.targets = try await apiClient.send(req)
        } catch {
            self.errorMessage = error.localizedDescription
        }
    }

    public func registerPushTarget(
        relayUrl: String,
        appId: String,
        pushToken: String,
        relaySecret: String? = nil
    ) async throws {
        guard let apiClient else { return }
        let body = MobilePushSubscribeRequest(
            relayUrl: relayUrl,
            platform: "ios",
            appId: appId,
            pushToken: pushToken,
            relaySecret: relaySecret
        )
        let bodyData = try JSONEncoder().encode(body)
        let req = try apiClient.buildRequest(
            path: "/api/notify/push/mobile?org=\(orgSlug)",
            method: "POST",
            body: bodyData
        )
        let _: PushTargetCreateResponse = try await apiClient.send(req)
        await loadTargets()
    }

    public func deleteTarget(id: String) async throws {
        guard let apiClient else { return }
        let req = try apiClient.buildRequest(
            path: "/api/notify/targets/\(id)?org=\(orgSlug)",
            method: "DELETE"
        )
        let _: [String: Bool] = try await apiClient.send(req)
        self.targets.removeAll(where: { $0.id == id })
    }

    public func loadDevices() async {
        guard let apiClient else { return }
        do {
            let req = try apiClient.buildRequest(path: "/api/auth/mobile/devices")
            self.devices = try await apiClient.send(req)
        } catch {
            self.errorMessage = error.localizedDescription
        }
    }

    public func revokeDevice(id: String) async throws {
        guard let apiClient else { return }
        let req = try apiClient.buildRequest(
            path: "/api/auth/mobile/devices/\(id)",
            method: "DELETE"
        )
        let _: [String: Bool] = try await apiClient.send(req)
        self.devices.removeAll(where: { $0.id == id })
    }

    public func switchInstance(to id: String) {
        sessionStore?.switchInstance(to: id)
    }

    public func removeInstance(id: String) {
        sessionStore?.registry.removeInstance(id: id)
        sessionStore?.instances = sessionStore?.registry.loadInstances() ?? []
        if sessionStore?.activeInstanceId == id {
            sessionStore?.activeInstanceId = sessionStore?.instances.first?.id
        }
    }
}
