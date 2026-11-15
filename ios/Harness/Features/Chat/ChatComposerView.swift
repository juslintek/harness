import SwiftUI

public struct ChatComposerView: View {
    @Binding public var text: String
    public let members: [ChatMember]
    public let onSend: (String) -> Void

    @FocusState private var isFocused: Bool

    public init(
        text: Binding<String>,
        members: [ChatMember],
        onSend: @escaping (String) -> Void
    ) {
        self._text = text
        self.members = members
        self.onSend = onSend
    }

    private var mentionQuery: String? {
        ChatMentionHelper.mentionQuery(in: text)
    }

    private var matchingMembers: [ChatMember] {
        guard let query = mentionQuery else { return [] }
        return ChatMentionHelper.filterMembers(members, prefix: query)
    }

    public var body: some View {
        VStack(spacing: 8) {
            if let _ = mentionQuery, !matchingMembers.isEmpty {
                mentionSuggestionsBar
            }

            HStack(alignment: .bottom, spacing: 8) {
                TextField("Message…", text: $text, axis: .vertical)
                    .lineLimit(1...5)
                    .focused($isFocused)
                    .font(.body)
                    .foregroundStyle(StudioNorthTheme.ink)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(StudioNorthTheme.surfaceRaised)
                    .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm))
                    .overlay(
                        RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm)
                            .stroke(StudioNorthTheme.border, lineWidth: StudioNorthTheme.hairline)
                    )
                    .accessibilityIdentifier("chat.composer")

                Button {
                    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !trimmed.isEmpty else { return }
                    text = ""
                    onSend(trimmed)
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.body.weight(.bold))
                        .foregroundStyle(canSend ? StudioNorthTheme.onBrand : StudioNorthTheme.inkMuted)
                        .frame(width: 38, height: 38)
                        .background(canSend ? StudioNorthTheme.brand : StudioNorthTheme.surfaceRaised)
                        .clipShape(Circle())
                        .overlay(
                            Circle()
                                .stroke(StudioNorthTheme.border, lineWidth: StudioNorthTheme.hairline)
                        )
                }
                .disabled(!canSend)
                .accessibilityLabel("Send message")
                .accessibilityIdentifier("chat.send")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(StudioNorthTheme.surface)
    }

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var mentionSuggestionsBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(matchingMembers) { member in
                    Button {
                        let inserted = ChatMentionHelper.insertMention(handle: member.handle, into: text)
                        text = inserted.text
                    } label: {
                        HStack(spacing: 6) {
                            StatusBadge(
                                text: member.kind == "agent" ? "agent" : "human",
                                color: member.kind == "agent" ? StudioNorthTheme.accent : StudioNorthTheme.inkMuted
                            )
                            Text("@\(member.handle)")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(StudioNorthTheme.ink)
                            Text(member.displayName)
                                .font(.caption)
                                .foregroundStyle(StudioNorthTheme.inkMuted)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(StudioNorthTheme.surfaceRaised)
                        .clipShape(Capsule())
                        .overlay(
                            Capsule()
                                .stroke(StudioNorthTheme.border, lineWidth: StudioNorthTheme.hairline)
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 4)
        }
        .frame(maxHeight: 44)
    }
}
