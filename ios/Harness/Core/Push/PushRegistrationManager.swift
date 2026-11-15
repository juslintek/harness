import Foundation
import Observation
import UserNotifications

#if canImport(UIKit)
import UIKit
#endif

public struct PushNotificationPayload: Equatable, Sendable {
    public let deepLink: URL?
    public let instanceOrigin: String?
    public let kind: String?

    public init(deepLink: URL?, instanceOrigin: String?, kind: String?) {
        self.deepLink = deepLink
        self.instanceOrigin = instanceOrigin
        self.kind = kind
    }
}

public enum PushGuardAction: String, Sendable {
    case approve = "approve"
    case deny = "deny"
}

@Observable
public final class PushRegistrationManager: NSObject, @unchecked Sendable {
    public static let shared = PushRegistrationManager()

    public static let guardApprovalCategoryId = "HARNESS_GUARD_APPROVAL"
    public static let approveGuardActionId = "APPROVE_GUARD"
    public static let denyGuardActionId = "DENY_GUARD"

    public var deviceTokenHex: String?
    public var authorizationStatus: UNAuthorizationStatus = .notDetermined
    public var lastError: String?
    public var pendingGuardAction: (approvalId: String, action: PushGuardAction, instanceOrigin: String?)?

    @MainActor
    public var onNotificationRoute: ((PushNotificationPayload, PushGuardAction?) -> Void)?

    public override init() {
        super.init()
    }

    public func configure() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        registerNotificationCategories(center: center)
    }

    public func registerNotificationCategories(center: UNUserNotificationCenter = .current()) {
        let approveAction = UNNotificationAction(
            identifier: Self.approveGuardActionId,
            title: "Approve",
            options: [.foreground, .authenticationRequired]
        )
        let denyAction = UNNotificationAction(
            identifier: Self.denyGuardActionId,
            title: "Deny",
            options: [.foreground, .destructive]
        )
        let guardCategory = UNNotificationCategory(
            identifier: Self.guardApprovalCategoryId,
            actions: [approveAction, denyAction],
            intentIdentifiers: [],
            options: []
        )
        center.setNotificationCategories([guardCategory])
    }

    @MainActor
    public func requestAuthorizationAndRegister() async -> Bool {
        let center = UNUserNotificationCenter.current()
        do {
            let granted = try await center.requestAuthorization(options: [.alert, .badge, .sound])
            let settings = await center.notificationSettings()
            self.authorizationStatus = settings.authorizationStatus
            if granted {
                #if canImport(UIKit)
                UIApplication.shared.registerForRemoteNotifications()
                #endif
            }
            return granted
        } catch {
            self.lastError = error.localizedDescription
            return false
        }
    }

    public func didRegisterForRemoteNotifications(deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in
            self.deviceTokenHex = hex
            self.lastError = nil
        }
    }

    public func didFailToRegisterForRemoteNotifications(error: Error) {
        Task { @MainActor in
            self.lastError = error.localizedDescription
        }
    }

    public func registerMobilePush(
        relayUrl: String,
        pushTokenHex: String? = nil,
        relaySecret: String? = nil,
        appId: String = Bundle.main.bundleIdentifier ?? "dev.harness.mobile",
        using client: HarnessAPIClient
    ) async throws -> PushTargetCreateResponse {
        let token = (pushTokenHex ?? deviceTokenHex ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !relayUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !token.isEmpty else {
            throw HarnessAPIError.httpError(statusCode: 400, message: "Relay URL and APNs push token are required.")
        }

        let body = MobilePushSubscribeRequest(
            relayUrl: relayUrl.trimmingCharacters(in: .whitespacesAndNewlines),
            platform: "ios",
            appId: appId,
            pushToken: token,
            relaySecret: relaySecret?.isEmpty == true ? nil : relaySecret
        )
        let bodyData = try JSONEncoder().encode(body)
        let req = try client.buildRequest(
            path: "/api/notify/push/mobile",
            method: "POST",
            body: bodyData
        )
        return try await client.send(req)
    }

    public static func parsePushUserInfo(_ userInfo: [AnyHashable: Any]) -> PushNotificationPayload? {
        let deepLinkRaw = (userInfo["deepLink"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let deepLink = deepLinkRaw.flatMap { $0.isEmpty ? nil : URL(string: $0) }
        let instanceOrigin = (userInfo["instanceOrigin"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let kind = (userInfo["kind"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)

        let normalizedOrigin = (instanceOrigin?.isEmpty == false) ? instanceOrigin : nil
        let normalizedKind = (kind?.isEmpty == false) ? kind : nil

        if deepLink == nil && normalizedOrigin == nil && normalizedKind == nil {
            return nil
        }
        return PushNotificationPayload(
            deepLink: deepLink,
            instanceOrigin: normalizedOrigin,
            kind: normalizedKind
        )
    }

    public static func guardAction(for actionIdentifier: String) -> PushGuardAction? {
        switch actionIdentifier {
        case approveGuardActionId:
            return .approve
        case denyGuardActionId:
            return .deny
        default:
            return nil
        }
    }
}

extension PushRegistrationManager: UNUserNotificationCenterDelegate {
    public nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .badge])
    }

    public nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        let actionId = response.actionIdentifier
        if let payload = Self.parsePushUserInfo(userInfo) {
            let guardAction = Self.guardAction(for: actionId)
            Task { @MainActor in
                self.onNotificationRoute?(payload, guardAction)
            }
        }
        completionHandler()
    }
}
