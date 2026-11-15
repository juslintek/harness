import SwiftUI

public struct ActionPill: View {
    private let title: String
    private let icon: String?
    private let isDestructive: Bool
    private let action: () -> Void

    public init(
        title: String,
        icon: String? = "arrow.up.right",
        isDestructive: Bool = false,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.icon = icon
        self.isDestructive = isDestructive
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                if let icon {
                    Image(systemName: icon)
                        .font(.caption.weight(.bold))
                }
            }
            .foregroundStyle(isDestructive ? StudioNorthTheme.onBrand : StudioNorthTheme.onBrand)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(isDestructive ? StudioNorthTheme.danger : StudioNorthTheme.brand)
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

public struct SecondaryLinkButton: View {
    private let title: String
    private let icon: String?
    private let action: () -> Void

    public init(
        title: String,
        icon: String? = nil,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.icon = icon
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let icon {
                    Image(systemName: icon)
                        .font(.caption)
                }
                Text(title)
                    .font(.subheadline)
            }
            .foregroundStyle(StudioNorthTheme.link)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.clear)
            .overlay(
                Capsule()
                    .stroke(StudioNorthTheme.border, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
}

public struct RaisedCard<Content: View>: View {
    private let content: Content

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        content
            .padding(16)
            .background(StudioNorthTheme.surfaceRaised)
            .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.md))
            .overlay(
                RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.md)
                    .stroke(StudioNorthTheme.border, lineWidth: 1)
            )
    }
}

public struct HairlineDivider: View {
    @Environment(\.displayScale) private var displayScale

    public init() {}

    public var body: some View {
        Rectangle()
            .fill(StudioNorthTheme.border)
            .frame(height: 1 / displayScale)
    }
}

public struct StatusBadge: View {
    private let text: String
    private let statusColor: Color

    public init(text: String, color: Color = StudioNorthTheme.inkMuted) {
        self.text = text
        self.statusColor = color
    }

    public var body: some View {
        Text(text.uppercased())
            .font(.system(size: 10, weight: .bold, design: .monospaced))
            .foregroundStyle(statusColor)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(statusColor.opacity(0.12))
            .clipShape(Capsule())
            .overlay(
                Capsule()
                    .stroke(statusColor.opacity(0.3), lineWidth: 1)
            )
    }
}
