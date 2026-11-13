import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = AppModel()
    private var signalSources: [DispatchSourceSignal] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Needed when launched by `swift run`, which has no app bundle.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate()
        // A plain SIGTERM would skip applicationWillTerminate and orphan the backend.
        for signalNumber in [SIGTERM, SIGINT] {
            signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
            source.setEventHandler { NSApp.terminate(nil) }
            source.resume()
            signalSources.append(source)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        model.backend.stop()
    }
}

@main
struct HarnessMacApp: App {
    @NSApplicationDelegateAdaptor private var delegate: AppDelegate

    var body: some Scene {
        let model = delegate.model
        WindowGroup("Harness") {
            RootView()
                .environment(model)
                .frame(minWidth: 760, minHeight: 480)
        }
        Window("Backend Log", id: "backend-log") {
            BackendView()
                .environment(model)
                .frame(minWidth: 520, minHeight: 360)
        }
        .keyboardShortcut("l", modifiers: [.command, .shift])
        .commands {
            CommandMenu("Harness") {
                Button("Refresh") { Task { await model.refresh() } }
                    .keyboardShortcut("r")
                    .disabled(model.me == nil)
                Button("Sign Out") { Task { await model.signOut() } }
                    .disabled(model.me == nil)
                Divider()
                Button("Restart Backend") { Task { await model.restartBackend() } }
            }
        }
    }
}
