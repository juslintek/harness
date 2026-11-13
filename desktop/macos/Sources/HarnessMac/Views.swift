import HarnessKit
import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            switch model.backend.state {
            case .stopped, .starting:
                VStack(spacing: 12) {
                    ProgressView().accessibilityLabel("Starting backend")
                    Text("Starting backend…")
                    LogView(lines: Array(model.backend.log.suffix(12)))
                        .frame(maxHeight: 200)
                }
                .padding()
            case .failed(let reason), .exited(let reason):
                VStack(spacing: 12) {
                    Label(reason, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                    Button("Retry") { Task { await model.restartBackend() } }
                        .keyboardShortcut(.defaultAction)
                    LogView(lines: Array(model.backend.log.suffix(20)))
                }
                .padding()
            case .running:
                if model.me == nil { SignInView() } else { MainView() }
            }
        }
        .task { await model.boot() }
    }
}

struct LogView: View {
    let lines: [String]

    var body: some View {
        ScrollView {
            Text(lines.joined(separator: "\n"))
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
        }
        .defaultScrollAnchor(.bottom)
        .background(.quaternary.opacity(0.4))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .accessibilityLabel("Backend log")
    }
}

struct SignInView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openWindow) private var openWindow
    @State private var email = ""
    @State private var code = ""
    @State private var codeSent = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Form {
            TextField("Email", text: $email)
                .disabled(codeSent || busy)
                .onSubmit(sendCode)
            if codeSent {
                TextField("Code from the backend log or email", text: $code)
                    .onSubmit(verify)
                    .accessibilityLabel("Sign-in code")
                Button("Show Backend Log") { openWindow(id: "backend-log") }
                    .buttonStyle(.link)
            }
            if let error {
                Text(error).foregroundStyle(.red).textSelection(.enabled)
            }
            HStack {
                if codeSent {
                    Button("Use Another Email") { codeSent = false; code = ""; error = nil }
                        .disabled(busy)
                    Button("Sign In", action: verify)
                        .keyboardShortcut(.defaultAction)
                        .disabled(busy || code.isEmpty)
                } else {
                    Button("Send Code", action: sendCode)
                        .keyboardShortcut(.defaultAction)
                        .disabled(busy || email.isEmpty)
                }
                if busy { ProgressView().controlSize(.small).accessibilityLabel("Working") }
            }
        }
        .frame(width: 360)
        .padding()
    }

    private func sendCode() {
        guard !busy, !email.isEmpty, let client = model.client else { return }
        run { try await client.requestCode(email: email); codeSent = true }
    }

    private func verify() {
        guard !busy, !code.isEmpty, let client = model.client else { return }
        run {
            do {
                _ = try await client.verify(email: email, code: code)
            } catch APIError.unauthorized {
                throw APIError.server(status: 401, code: "wrong or expired code")
            }
            await model.refresh()
        }
    }

    private func run(_ work: @escaping () async throws -> Void) {
        busy = true
        error = nil
        Task {
            do { try await work() } catch { self.error = error.localizedDescription }
            busy = false
        }
    }
}

private enum Pane: Hashable { case account, backend }

struct MainView: View {
    @State private var pane: Pane? = .account

    var body: some View {
        NavigationSplitView {
            List(selection: $pane) {
                Label("Account", systemImage: "person.crop.circle").tag(Pane.account)
                Label("Backend", systemImage: "server.rack").tag(Pane.backend)
            }
            .navigationSplitViewColumnWidth(min: 160, ideal: 180)
        } detail: {
            switch pane ?? .account {
            case .account: AccountView()
            case .backend: BackendView()
            }
        }
    }
}

struct AccountView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let me = model.me {
                Form {
                    LabeledContent("Name", value: me.user.name)
                    LabeledContent("Email", value: me.user.email)
                    LabeledContent("Sign-in method", value: me.session.method)
                }
            }
            Text("Sessions").font(.headline)
            Table(model.sessions) {
                TableColumn("Device") { Text($0.userAgent ?? "Unknown") }
                TableColumn("Method") { Text($0.method) }.width(60)
                TableColumn("Created") { Text($0.created, format: .dateTime.day().month().year().hour().minute()) }
                TableColumn("Last seen") { Text($0.lastSeen, format: .dateTime.day().month().hour().minute()) }
                TableColumn("") { session in
                    if session.current {
                        Text("This session").foregroundStyle(.secondary)
                    } else {
                        Button("Revoke", role: .destructive) { Task { await model.revoke(session) } }
                            .accessibilityLabel("Revoke session from \(session.userAgent ?? "unknown device")")
                    }
                }
                .width(90)
            }
            .overlay {
                if let message = model.errorMessage {
                    ContentUnavailableView("Could not load sessions", systemImage: "exclamationmark.triangle", description: Text(message))
                } else if model.loading && model.sessions.isEmpty {
                    ProgressView().accessibilityLabel("Loading sessions")
                } else if model.sessions.isEmpty {
                    ContentUnavailableView("No sessions", systemImage: "person.crop.circle.badge.questionmark")
                }
            }
        }
        .padding()
        .navigationTitle("Account")
        .toolbar {
            Button("Refresh", systemImage: "arrow.clockwise") { Task { await model.refresh() } }
                .disabled(model.loading)
        }
    }
}

struct BackendView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Form {
                LabeledContent("Instance", value: model.backend.health?.instanceId ?? "-")
                LabeledContent("Version", value: model.backend.health?.version ?? "-")
                if case .running(let port) = model.backend.state {
                    LabeledContent("Port", value: String(port))
                }
                LabeledContent("State", value: String(describing: model.backend.state))
            }
            LogView(lines: model.backend.log)
        }
        .padding()
        .navigationTitle("Backend")
    }
}
