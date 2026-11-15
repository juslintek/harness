import SwiftUI

public struct HaltConfirmSheet: View {
    @Bindable var store: AppSessionStore
    @Environment(\.dismiss) private var dismiss
    @State private var isLoading = false
    @State private var errorText: String?

    public init(store: AppSessionStore) {
        self.store = store
    }

    public var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Image(systemName: "exclamationmark.octagon.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(StudioNorthTheme.danger)
                    .padding(.top, 24)

                Text(store.isHalted ? "Resume System" : "Emergency Halt")
                    .font(.title2.weight(.bold))
                    .foregroundStyle(StudioNorthTheme.ink)

                Text(
                    store.isHalted
                        ? "Resuming will allow agents and background runs to continue operation."
                        : "Halting immediately freezes all agent runs and queues across the instance. This action requires step-up authentication."
                )
                .font(.body)
                .foregroundStyle(StudioNorthTheme.inkMuted)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)

                if let errorText {
                    Text(errorText)
                        .font(.footnote)
                        .foregroundStyle(StudioNorthTheme.danger)
                        .padding(.horizontal)
                }

                Spacer()

                HStack(spacing: 16) {
                    SecondaryLinkButton(title: "Cancel") {
                        dismiss()
                    }

                    if isLoading {
                        ProgressView()
                            .padding(.horizontal, 24)
                    } else {
                        ActionPill(
                            title: store.isHalted ? "Resume Now" : "Confirm Halt",
                            icon: store.isHalted ? "play.fill" : "pause.fill",
                            isDestructive: !store.isHalted
                        ) {
                            Task {
                                isLoading = true
                                errorText = nil
                                do {
                                    try await store.toggleHalt(to: !store.isHalted)
                                    dismiss()
                                } catch {
                                    errorText = error.localizedDescription
                                }
                                isLoading = false
                            }
                        }
                    }
                }
                .padding(.bottom, 24)
            }
            .padding()
            .background(StudioNorthTheme.surface)
            .navigationTitle("System Guard")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
