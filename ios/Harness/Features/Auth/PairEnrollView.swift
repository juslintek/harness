import SwiftUI

public struct PairEnrollView: View {
    @Bindable var store: AppSessionStore
    @Environment(\.dismiss) private var dismiss

    @State private var origin: String = "http://localhost:4100"
    @State private var pairCode: String = ""
    @State private var isScanning = false
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    public init(store: AppSessionStore) {
        self.store = store
    }

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    VStack(spacing: 8) {
                        Text("Connect Harness")
                            .font(.title2.weight(.bold))
                            .foregroundStyle(StudioNorthTheme.ink)

                        Text("Pair this mobile device with a running Harness instance using a 6-digit code or QR code.")
                            .font(.subheadline)
                            .foregroundStyle(StudioNorthTheme.inkMuted)
                            .multilineTextAlignment(.center)
                    }
                    .padding(.top, 16)

                    RaisedCard {
                        VStack(alignment: .leading, spacing: 16) {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Instance Origin")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(StudioNorthTheme.inkMuted)

                                TextField("https://harness.example.com", text: $origin)
                                    .textFieldStyle(.roundedBorder)
                                    .autocorrectionDisabled()
                                    .textInputAutocapitalization(.never)
                                    .accessibilityIdentifier("pair.origin")
                            }

                            VStack(alignment: .leading, spacing: 6) {
                                Text("Pairing Code")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(StudioNorthTheme.inkMuted)

                                TextField("Paste pairing code", text: $pairCode)
                                    .textFieldStyle(.roundedBorder)
                                    .autocorrectionDisabled()
                                    .textInputAutocapitalization(.never)
                                    .accessibilityIdentifier("pair.code")
                            }

                            HairlineDivider()

                            HStack {
                                SecondaryLinkButton(title: "Scan QR", icon: "qrcode") {
                                    isScanning = true
                                }
                                .accessibilityIdentifier("pair.scanQR")

                                Spacer()

                                if isSubmitting {
                                    ProgressView()
                                } else {
                                    ActionPill(title: "Pair Device") {
                                        submitPairing()
                                    }
                                    .accessibilityIdentifier("pair.submit")
                                }
                            }
                        }
                    }

                    if let errorMessage {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundStyle(StudioNorthTheme.danger)
                            .padding(.horizontal)
                            .accessibilityIdentifier("pair.error")
                    }

                    Spacer()
                }
                .padding(20)
            }
            .background(StudioNorthTheme.surface)
            .navigationTitle("Pair Device")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented: $isScanning) {
                QRScannerSheet { scannedUri in
                    parseScannedUri(scannedUri)
                }
            }
            .onAppear {
                if let deepLink = store.pendingDeepLink {
                    parseScannedUri(deepLink.absoluteString)
                } else if let testOrigin = ProcessInfo.processInfo.environment["HARNESS_TEST_ORIGIN"],
                          !testOrigin.isEmpty {
                    self.origin = testOrigin
                    let testPair = ProcessInfo.processInfo.environment["HARNESS_TEST_PAIR_CODE"] ?? ""
                    let testEnroll = ProcessInfo.processInfo.environment["HARNESS_TEST_ENROLL_CODE"] ?? ""
                    if !testPair.isEmpty {
                        self.pairCode = testPair
                    } else if !testEnroll.isEmpty {
                        self.pairCode = testEnroll
                    }
                }
            }
        }
    }

    private func parseScannedUri(_ uri: String) {
        guard let url = URL(string: uri),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return }
        if let orig = components.queryItems?.first(where: { $0.name == "origin" })?.value {
            self.origin = orig
        }
        if let code = components.queryItems?.first(where: { $0.name == "code" })?.value {
            self.pairCode = code
        }
    }

    private func submitPairing() {
        guard !origin.isEmpty, !pairCode.isEmpty else {
            errorMessage = "Please enter both origin and pair code."
            return
        }

        isSubmitting = true
        errorMessage = nil

        Task {
            do {
                try await store.pair(origin: origin, code: pairCode)
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
            isSubmitting = false
        }
    }
}
