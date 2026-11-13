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

private enum Pane: Hashable { case account, backend, board(String) }

struct MainView: View {
    @Environment(AppModel.self) private var model
    @State private var pane: Pane?
    @State private var orgSlug: String?
    @State private var projects: [Project] = []
    @State private var projectsPhase = Phase.loading
    @State private var showNewOrg = false
    @State private var showNewProject = false

    private var org: Org? { model.orgs.first { $0.slug == orgSlug } ?? model.orgs.first }

    var body: some View {
        NavigationSplitView {
            List(selection: $pane) {
                Section("Projects") {
                    ForEach(projects) { project in
                        Label("\(project.name) Board", systemImage: "rectangle.3.group").tag(Pane.board(project.id))
                    }
                    if projectsPhase == .unavailable {
                        Text("Not available on this backend").foregroundStyle(.secondary)
                    } else if case .failed(let message) = projectsPhase {
                        Text(message).foregroundStyle(.red)
                        Button("Retry") { Task { await loadProjects() } }
                    }
                }
                Section {
                    Label("Account", systemImage: "person.crop.circle").tag(Pane.account)
                    Label("Backend", systemImage: "server.rack").tag(Pane.backend)
                }
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 200)
            .safeAreaInset(edge: .top) {
                if !model.orgs.isEmpty {
                    Picker("Organisation", selection: Binding(get: { org?.slug }, set: { orgSlug = $0 })) {
                        ForEach(model.orgs) { Text($0.name).tag(Optional($0.slug)) }
                    }
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
                }
            }
            .safeAreaInset(edge: .bottom) {
                HStack {
                    Button("New Organisation", systemImage: "plus") { showNewOrg = true }
                    if org != nil { Button("New Project", systemImage: "plus.rectangle") { showNewProject = true } }
                }
                .buttonStyle(.borderless)
                .labelStyle(.titleAndIcon)
                .padding(8)
            }
        } detail: {
            detail
        }
        .task(id: org?.id) { await loadProjects() }
        .sheet(isPresented: $showNewOrg) {
            TwoFieldSheet(title: "New Organisation", first: "Name", second: "Slug (lowercase letters, digits, - and _)") { name, slug in
                guard let client = model.client else { return }
                let created = try await client.createOrg(name: name, slug: slug)
                await model.refresh()
                orgSlug = created.slug
            }
        }
        .sheet(isPresented: $showNewProject) {
            TwoFieldSheet(title: "New Project", first: "Key (for example WEB)", second: "Name") { key, name in
                guard let client = model.client, let org else { return }
                let created = try await client.createProject(orgSlug: org.slug, key: key, name: name)
                await loadProjects()
                pane = .board(created.id)
            }
        }
    }

    @ViewBuilder private var detail: some View {
        switch pane {
        case .account: AccountView()
        case .backend: BackendView()
        case .board(let id):
            if let client = model.client, let org, let project = projects.first(where: { $0.id == id }) {
                BoardView(client: client, org: org, project: project)
            } else {
                ContentUnavailableView("Select a project", systemImage: "rectangle.3.group")
            }
        case nil:
            if model.orgs.isEmpty {
                ContentUnavailableView {
                    Label("No organisation yet", systemImage: "building.2")
                } actions: {
                    Button("Create Organisation") { showNewOrg = true }
                }
            } else if projectsPhase == .ready && projects.isEmpty {
                ContentUnavailableView {
                    Label("No projects yet", systemImage: "rectangle.3.group")
                } actions: {
                    Button("New Project") { showNewProject = true }
                }
            } else {
                PhaseView(phase: projectsPhase) { Task { await loadProjects() } }
            }
        }
    }

    private func loadProjects() async {
        guard let client = model.client, let org else {
            projects = []
            return
        }
        projectsPhase = .loading
        do {
            projects = try await client.projects(orgSlug: org.slug)
            projectsPhase = .ready
            if case .board(let id) = pane, projects.contains(where: { $0.id == id }) { return }
            pane = projects.first.map { .board($0.id) } ?? (pane == .account || pane == .backend ? pane : nil)
        } catch {
            if !Task.isCancelled { projects = []; projectsPhase = Phase(error) }
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
