import Foundation
import Observation

public enum AppTab: String, CaseIterable, Identifiable, Sendable {
    case approvals
    case board
    case runs
    case chat
    case workspace

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .approvals: return "Approvals"
        case .board: return "Board"
        case .runs: return "Runs"
        case .chat: return "Chat"
        case .workspace: return "Workspace"
        }
    }

    public var icon: String {
        switch self {
        case .approvals: return "checkmark.shield"
        case .board: return "square.grid.2x2"
        case .runs: return "play.circle"
        case .chat: return "bubble.left.and.bubble.right"
        case .workspace: return "folder"
        }
    }
}

@Observable
public final class AppSessionStore: @unchecked Sendable {
    public var instances: [InstanceRecord] = []
    public var activeInstanceId: String?
    public var selectedTab: AppTab = .approvals
    public var pendingDeepLink: URL?
    public var pendingGuardDecision: (approvalId: String, decision: String)?
    public var isHalted: Bool = false
    public var isPairingSheetPresented: Bool = false
    public var isHaltSheetPresented: Bool = false
    public var errorMessage: String?

    public let registry: InstanceRegistry
    public let keychain: KeychainTokenStore
    public let signer: DeviceKeySigning

    public var activeInstance: InstanceRecord? {
        guard let activeInstanceId else { return instances.first }
        return instances.first(where: { $0.id == activeInstanceId }) ?? instances.first
    }

    public var isInstanceAdmin: Bool {
        activeInstance?.user.instanceAdmin ?? false
    }

    public var currentOrgRole: String {
        guard let active = activeInstance else { return "viewer" }
        let current = active.orgs.first(where: { $0.slug == active.selectedOrgSlug })
        return current?.role ?? "viewer"
    }

    public init(
        registry: InstanceRegistry = .shared,
        keychain: KeychainTokenStore = .shared,
        signer: DeviceKeySigning? = nil
    ) {
        self.registry = registry
        self.keychain = keychain
        if let signer {
            self.signer = signer
        } else {
            self.signer = (try? DeviceKeySigner.makeDefault(keychain: keychain))
                ?? DeviceKeySigner(softwareKey: .init())
        }
        if ProcessInfo.processInfo.environment["HARNESS_RESET_STATE"] == "1" {
            registry.saveInstances([])
        }
        self.instances = registry.loadInstances()
        self.activeInstanceId = instances.first?.id
    }

    public func switchInstance(to id: String) {
        guard instances.contains(where: { $0.id == id }) else { return }
        activeInstanceId = id
    }

    public func selectOrg(slug: String) {
        guard let active = activeInstance,
              let idx = instances.firstIndex(where: { $0.id == active.id }) else { return }
        instances[idx].selectedOrgSlug = slug
        registry.saveInstances(instances)
    }

    public func apiClient(for instance: InstanceRecord) -> HarnessAPIClient {
        HarnessAPIClient(
            origin: instance.origin,
            tokenProvider: { [weak self] in
                self?.keychain.getToken(for: instance.id)
            },
            sessionIdProvider: { [weak self] in
                self?.instances.first(where: { $0.id == instance.id })?.sessionId
            },
            signer: signer
        )
    }

    public func currentAPIClient() -> HarnessAPIClient? {
        guard let active = activeInstance else { return nil }
        return apiClient(for: active)
    }

    public func handleDeepLink(url: URL, instanceOriginHint: String? = nil) -> Bool {
        guard let parsed = DeepLinkRouter.parse(url, instanceOriginHint: instanceOriginHint) else {
            return false
        }

        if let matched = DeepLinkRouter.matchingInstance(for: parsed.instanceOrigin, in: instances) {
            activeInstanceId = matched.id
        }

        pendingDeepLink = url

        switch parsed.target {
        case .pair:
            isPairingSheetPresented = true
            return true

        case .approval:
            selectedTab = .approvals
            return true

        case .run:
            selectedTab = .runs
            return true

        case .chat(let slug, _):
            if let slug,
               let active = activeInstance,
               active.orgs.contains(where: { $0.slug == slug }) {
                selectOrg(slug: slug)
            }
            selectedTab = .chat
            return true

        case .board:
            selectedTab = .board
            return true

        case .workspace, .open:
            selectedTab = .workspace
            return true

        case .tab(let tab):
            selectedTab = tab
            return true
        }
    }

    public func handlePushPayload(
        _ payload: PushNotificationPayload,
        guardAction: PushGuardAction? = nil
    ) -> Bool {
        if let matched = DeepLinkRouter.matchingInstance(for: payload.instanceOrigin, in: instances) {
            activeInstanceId = matched.id
        }

        var routed = false
        if let deepLink = payload.deepLink {
            routed = handleDeepLink(url: deepLink, instanceOriginHint: payload.instanceOrigin)
            if let guardAction,
               let parsed = DeepLinkRouter.parse(deepLink, instanceOriginHint: payload.instanceOrigin),
               case .approval(let approvalId?) = parsed.target {
                pendingGuardDecision = (approvalId: approvalId, decision: guardAction.rawValue)
            }
        } else if payload.kind == "guard_approval" {
            selectedTab = .approvals
            routed = true
        }
        return routed
    }

    public func pair(
        origin: String,
        code: String,
        deviceName: String = "iPhone"
    ) async throws {
        let tempClient = HarnessAPIClient(
            origin: origin,
            tokenProvider: { nil },
            signer: signer
        )

        let optReq = MobilePairOptionsRequest(code: code, deviceName: deviceName)
        let optRes = try await tempClient.postPairOptions(optReq)

        let canonical = "harness-mobile-pair-v1|\(optRes.rpOrigin)|\(optRes.challengeId)|\(optRes.nonce)"
        let signature = try await signer.sign(canonicalAscii: canonical)

        let verifyReq = MobilePairVerifyRequest(
            challengeId: optRes.challengeId,
            code: code,
            deviceName: deviceName,
            publicKeySpki: signer.publicKeySpkiBase64Url,
            signature: signature
        )
        let verifyRes = try await tempClient.postPairVerify(verifyReq)

        let instanceId = UUID().uuidString
        try keychain.saveToken(verifyRes.token, for: instanceId)

        let authedClient = HarnessAPIClient(
            origin: origin,
            tokenProvider: { verifyRes.token },
            signer: signer
        )
        let me = try await authedClient.getMe()

        let record = InstanceRecord(
            id: instanceId,
            origin: origin,
            deviceId: verifyRes.deviceId,
            user: me.user,
            orgs: me.orgs,
            selectedOrgSlug: me.orgs.first(where: { $0.slug != "personal" })?.slug ?? me.orgs.first?.slug ?? "personal",
            sessionId: me.session.id
        )

        registry.addOrUpdateInstance(record)
        instances = registry.loadInstances()
        activeInstanceId = record.id
        isPairingSheetPresented = false
    }

    public func toggleHalt(to halted: Bool) async throws {
        guard let client = currentAPIClient() else { return }
        let res = try await client.postHalt(HaltRequest(halted: halted))
        isHalted = res.halted
        isHaltSheetPresented = false
    }
}
