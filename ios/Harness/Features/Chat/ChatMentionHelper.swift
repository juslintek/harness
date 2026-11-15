import Foundation

public struct ChatMentionHelper: Sendable {
    public static func mentionQuery(in text: String, upTo cursor: Int? = nil) -> String? {
        let bound = cursor.map { max(0, min($0, text.count)) } ?? text.count
        let prefixText = String(text.prefix(bound))

        guard let atIndex = prefixText.lastIndex(of: "@") else { return nil }

        if atIndex > prefixText.startIndex {
            let prevIndex = prefixText.index(before: atIndex)
            let prevChar = prefixText[prevIndex]
            if prevChar.isLetter || prevChar.isNumber || prevChar == "_" || prevChar == "@" || prevChar == "." || prevChar == "-" {
                return nil
            }
        }

        let afterAt = prefixText[prefixText.index(after: atIndex)...]
        for char in afterAt {
            guard char.isLetter || char.isNumber || char == "_" || char == "-" else {
                return nil
            }
        }
        return String(afterAt).lowercased()
    }

    public static func filterMembers(_ members: [ChatMember], prefix: String) -> [ChatMember] {
        if prefix.isEmpty {
            return members
        }
        let lower = prefix.lowercased()
        return members.filter {
            $0.handle.lowercased().hasPrefix(lower) ||
            $0.displayName.lowercased().contains(lower)
        }
    }

    public static func insertMention(handle: String, into text: String, cursor: Int? = nil) -> (text: String, newCursor: Int) {
        let bound = cursor.map { max(0, min($0, text.count)) } ?? text.count
        let prefixText = String(text.prefix(bound))
        var suffixText = String(text.suffix(text.count - bound))

        guard let atIndex = prefixText.lastIndex(of: "@") else {
            return (text, bound)
        }

        let beforeAt = String(prefixText[..<atIndex])
        let replacement = "@\(handle) "
        if suffixText.hasPrefix(" ") {
            suffixText.removeFirst()
        }
        let newPrefix = beforeAt + replacement
        let resultText = newPrefix + suffixText
        return (resultText, newPrefix.count)
    }
}
