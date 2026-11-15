import SwiftUI
import UIKit

final class HarnessAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        PushRegistrationManager.shared.configure()
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        PushRegistrationManager.shared.didRegisterForRemoteNotifications(deviceToken: deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        PushRegistrationManager.shared.didFailToRegisterForRemoteNotifications(error: error)
    }
}

@main
struct HarnessApp: App {
    @UIApplicationDelegateAdaptor(HarnessAppDelegate.self) private var appDelegate
    @State private var store = AppSessionStore()

    var body: some Scene {
        WindowGroup {
            RootShellView(store: store)
                .onOpenURL { url in
                    _ = store.handleDeepLink(url: url)
                }
                .task {
                    PushRegistrationManager.shared.onNotificationRoute = { payload, guardAction in
                        _ = store.handlePushPayload(payload, guardAction: guardAction)
                    }
                }
        }
    }
}
