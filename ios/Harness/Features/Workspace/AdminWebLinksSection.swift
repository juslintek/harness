import SwiftUI
import SafariServices

private struct SafariWebView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }

    func updateUIViewController(_ uiViewController: SFSafariViewController, context: Context) {}
}

public struct AdminWebLinksSection: View {
    public let origin: String
    public let orgSlug: String
    public let isInstanceAdmin: Bool

    @State private var targetURL: URL?

    public init(
        origin: String,
        orgSlug: String,
        isInstanceAdmin: Bool
    ) {
        self.origin = origin.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        self.orgSlug = orgSlug
        self.isInstanceAdmin = isInstanceAdmin
    }

    private var orgLinks: [(title: String, path: String)] {
        [
            ("Hiring", "/#/o/\(orgSlug)/hiring"),
            ("Policies", "/#/o/\(orgSlug)/policies"),
            ("Audit Logs", "/#/o/\(orgSlug)/logs"),
            ("Org Settings", "/#/o/\(orgSlug)/settings")
        ]
    }

    private var instanceLinks: [(title: String, path: String)] {
        [
            ("Agents Registry", "/#/agents"),
            ("Global Search", "/#/search"),
            ("Integrations", "/#/integrations"),
            ("Federation", "/#/federation"),
            ("Deployment", "/#/deploy"),
            ("System Updates", "/#/updates")
        ]
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            // Org Admin Links
            VStack(alignment: .leading, spacing: 8) {
                Text("Organization Administration")
                    .font(.headline)
                    .foregroundStyle(StudioNorthTheme.ink)

                Text("Manage org hiring pipelines, policies, and configuration in web admin.")
                    .font(.caption)
                    .foregroundStyle(StudioNorthTheme.inkMuted)

                ForEach(orgLinks, id: \.path) { link in
                    linkRow(title: link.title, fullURLString: "\(origin)\(link.path)")
                }
            }

            // Instance Admin Links
            if isInstanceAdmin {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("Instance Control Plane")
                            .font(.headline)
                            .foregroundStyle(StudioNorthTheme.ink)
                        Spacer()
                        StatusBadge(text: "Admin", color: StudioNorthTheme.danger)
                    }

                    Text("Fleet-wide agents, infrastructure deploy, and cluster settings.")
                        .font(.caption)
                        .foregroundStyle(StudioNorthTheme.inkMuted)

                    ForEach(instanceLinks, id: \.path) { link in
                        linkRow(title: link.title, fullURLString: "\(origin)\(link.path)")
                    }
                }
            }
        }
        .padding(.horizontal)
        .sheet(item: Binding<IdentifiableURL?>(
            get: { targetURL.map { IdentifiableURL(url: $0) } },
            set: { targetURL = $0?.url }
        )) { item in
            SafariWebView(url: item.url)
                .ignoresSafeArea()
        }
    }

    @ViewBuilder
    private func linkRow(title: String, fullURLString: String) -> some View {
        Button {
            if let url = URL(string: fullURLString) {
                targetURL = url
            }
        } label: {
            HStack {
                Text(title)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(StudioNorthTheme.ink)
                Spacer()
                Text("↗")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(StudioNorthTheme.link)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(StudioNorthTheme.surfaceRaised)
            .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm))
            .overlay(
                RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm)
                    .stroke(StudioNorthTheme.border, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
}

private struct IdentifiableURL: Identifiable {
    let id = UUID()
    let url: URL
}
