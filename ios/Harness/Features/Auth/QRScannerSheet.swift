import SwiftUI
import AVFoundation

public struct QRScannerSheet: View {
    @Environment(\.dismiss) private var dismiss
    private let onCodeScanned: (String) -> Void
    @State private var manualInput = ""

    public init(onCodeScanned: @escaping (String) -> Void) {
        self.onCodeScanned = onCodeScanned
    }

    public var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Text("Scan Pair QR Code")
                    .font(.headline)
                    .foregroundStyle(StudioNorthTheme.ink)

                ZStack {
                    RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.md)
                        .fill(StudioNorthTheme.surfaceRaised)
                        .overlay(
                            RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.md)
                                .stroke(StudioNorthTheme.border, lineWidth: 1)
                        )
                        .frame(height: 280)

                    VStack(spacing: 12) {
                        Image(systemName: "qrcode.viewfinder")
                            .font(.system(size: 64))
                            .foregroundStyle(StudioNorthTheme.inkMuted)

                        Text("Point camera at web console QR code")
                            .font(.subheadline)
                            .foregroundStyle(StudioNorthTheme.inkMuted)
                    }
                }
                .padding(.horizontal)

                VStack(alignment: .leading, spacing: 8) {
                    Text("Or paste URI manually:")
                        .font(.caption)
                        .foregroundStyle(StudioNorthTheme.inkMuted)

                    TextField("harness://pair?origin=...&code=...", text: $manualInput)
                        .textFieldStyle(.roundedBorder)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }
                .padding(.horizontal)

                Spacer()

                HStack {
                    SecondaryLinkButton(title: "Cancel") {
                        dismiss()
                    }

                    Spacer()

                    ActionPill(title: "Use URI") {
                        let trimmed = manualInput.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !trimmed.isEmpty {
                            onCodeScanned(trimmed)
                            dismiss()
                        }
                    }
                }
                .padding(.horizontal)
                .padding(.bottom, 16)
            }
            .padding(.top, 16)
            .background(StudioNorthTheme.surface)
            .navigationTitle("Scanner")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
