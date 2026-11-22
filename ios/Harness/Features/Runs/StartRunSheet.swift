import SwiftUI

public struct StartRunSheet: View {
    public let store: RunsStore
    public let onDismiss: () -> Void
    public let onRunStarted: (String) -> Void

    @State private var agentId: String = "claude-code"
    @State private var repo: String = ""
    @State private var branch: String = ""
    @State private var model: String = ""
    @State private var prompt: String = ""
    @State private var isSubmitting: Bool = false
    @State private var localError: String?

    private let availableAgents = ["claude-code", "codex", "junie", "antigravity", "copilot"]

    public init(
        store: RunsStore,
        onDismiss: @escaping () -> Void,
        onRunStarted: @escaping (String) -> Void = { _ in }
    ) {
        self.store = store
        self.onDismiss = onDismiss
        self.onRunStarted = onRunStarted
    }

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let err = localError ?? store.bannerMessage, store.bannerIsError || localError != nil {
                        HStack(spacing: 8) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(StudioNorthTheme.danger)
                            Text(err)
                                .font(.subheadline)
                                .foregroundStyle(StudioNorthTheme.ink)
                        }
                        .padding(12)
                        .background(StudioNorthTheme.danger.opacity(0.1))
                        .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm))
                    }

                    RaisedCard {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Agent")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(StudioNorthTheme.inkMuted)

                            Picker("Agent", selection: $agentId) {
                                ForEach(availableAgents, id: \.self) { agent in
                                    Text(agent).tag(agent)
                                }
                            }
                            .pickerStyle(.segmented)

                            Text("Repository Path")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(StudioNorthTheme.inkMuted)

                            TextField("/path/to/repo", text: $repo)
                                .textFieldStyle(.plain)
                                .font(.subheadline.monospaced())
                                .padding(10)
                                .background(StudioNorthTheme.surface)
                                .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm))
                                .overlay(
                                    RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm)
                                        .stroke(StudioNorthTheme.border, lineWidth: 1)
                                )

                            HStack(spacing: 12) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("Branch (Optional)")
                                        .font(.caption.weight(.bold))
                                        .foregroundStyle(StudioNorthTheme.inkMuted)

                                    TextField("main", text: $branch)
                                        .textFieldStyle(.plain)
                                        .font(.subheadline.monospaced())
                                        .padding(10)
                                        .background(StudioNorthTheme.surface)
                                        .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm))
                                        .overlay(
                                            RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm)
                                                .stroke(StudioNorthTheme.border, lineWidth: 1)
                                        )
                                }

                                VStack(alignment: .leading, spacing: 4) {
                                    Text("Model (Optional)")
                                        .font(.caption.weight(.bold))
                                        .foregroundStyle(StudioNorthTheme.inkMuted)

                                    TextField("default", text: $model)
                                        .textFieldStyle(.plain)
                                        .font(.subheadline.monospaced())
                                        .padding(10)
                                        .background(StudioNorthTheme.surface)
                                        .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm))
                                        .overlay(
                                            RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm)
                                                .stroke(StudioNorthTheme.border, lineWidth: 1)
                                        )
                                }
                            }

                            Text("Prompt")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(StudioNorthTheme.inkMuted)

                            TextEditor(text: $prompt)
                                .font(.subheadline)
                                .frame(minHeight: 100)
                                .padding(6)
                                .background(StudioNorthTheme.surface)
                                .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm))
                                .overlay(
                                    RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm)
                                        .stroke(StudioNorthTheme.border, lineWidth: 1)
                                )
                        }
                    }

                    ActionPill(
                        title: isSubmitting ? "Launching..." : "Start Run ↗",
                        icon: nil
                    ) {
                        launchRun()
                    }
                    .disabled(isSubmitting || repo.trimmingCharacters(in: .whitespaces).isEmpty || prompt.trimmingCharacters(in: .whitespaces).isEmpty)
                    .opacity(isSubmitting ? 0.6 : 1.0)
                }
                .padding()
            }
            .background(StudioNorthTheme.surface)
            .navigationTitle("New Run")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        onDismiss()
                    }
                    .foregroundStyle(StudioNorthTheme.ink)
                }
            }
        }
    }

    private func launchRun() {
        guard !repo.isEmpty, !prompt.isEmpty else { return }
        isSubmitting = true
        localError = nil
        Task {
            do {
                let runId = try await store.startRun(
                    agentId: agentId,
                    repo: repo,
                    prompt: prompt,
                    model: model.isEmpty ? nil : model
                )
                isSubmitting = false
                onDismiss()
                onRunStarted(runId)
            } catch {
                localError = error.localizedDescription
                isSubmitting = false
            }
        }
    }
}
