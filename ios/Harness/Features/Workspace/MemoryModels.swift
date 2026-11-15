import Foundation

public struct MemoryWriteResult: Codable, Sendable, Equatable {
    public let note: MemoryNoteDetail
    public let redacted: Bool

    public init(note: MemoryNoteDetail, redacted: Bool = false) {
        self.note = note
        self.redacted = redacted
    }
}

public struct MemoryWriteEnvelope: Decodable, Sendable {
    public let note: MemoryNoteDetail
    public let redacted: Bool

    public init(note: MemoryNoteDetail, redacted: Bool = false) {
        self.note = note
        self.redacted = redacted
    }

    public init(from decoder: Decoder) throws {
        if let container = try? decoder.container(keyedBy: CodingKeys.self),
           let note = try? container.decode(MemoryNoteDetail.self, forKey: .note) {
            self.note = note
            self.redacted = (try? container.decode(Bool.self, forKey: .redacted)) ?? false
        } else {
            let note = try MemoryNoteDetail(from: decoder)
            self.note = note
            self.redacted = false
        }
    }

    private enum CodingKeys: String, CodingKey {
        case note, redacted
    }
}

public struct MemoryCreateNoteRequest: Codable, Sendable {
    public let scope: String
    public let projectId: String?
    public let rel: String
    public let body: String
    public let type: String?
    public let tags: [String]?

    public init(
        scope: String = "org",
        projectId: String? = nil,
        rel: String,
        body: String,
        type: String? = nil,
        tags: [String]? = nil
    ) {
        self.scope = scope
        self.projectId = projectId
        self.rel = rel
        self.body = body
        self.type = type
        self.tags = tags
    }
}

public struct MemoryUpdateNoteRequest: Codable, Sendable {
    public let baseHash: String
    public let body: String
    public let type: String?
    public let tags: [String]?

    public init(
        baseHash: String,
        body: String,
        type: String? = nil,
        tags: [String]? = nil
    ) {
        self.baseHash = baseHash
        self.body = body
        self.type = type
        self.tags = tags
    }
}

public struct MemoryLessonDecisionRequest: Codable, Sendable {
    public let decision: String
    public let reason: String
    public let body: String?

    public init(decision: String, reason: String, body: String? = nil) {
        self.decision = decision
        self.reason = reason
        self.body = body
    }
}

public struct MemoryConflictState: Sendable, Equatable {
    public let latestRemote: MemoryNoteDetail
    public let localDraft: String
    public let conflictHash: String

    public init(latestRemote: MemoryNoteDetail, localDraft: String, conflictHash: String) {
        self.latestRemote = latestRemote
        self.localDraft = localDraft
        self.conflictHash = conflictHash
    }
}

public enum DiffLineKind: Sendable, Equatable {
    case added
    case removed
    case unchanged
}

public struct DiffLine: Identifiable, Sendable, Equatable {
    public let id: String
    public let kind: DiffLineKind
    public let text: String

    public init(id: String = UUID().uuidString, kind: DiffLineKind, text: String) {
        self.id = id
        self.kind = kind
        self.text = text
    }
}

public enum MemoryDiffEngine {
    public static func computeLineDiff(before: String?, after: String?) -> [DiffLine] {
        let beforeLines = (before ?? "").split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let afterLines = (after ?? "").split(separator: "\n", omittingEmptySubsequences: false).map(String.init)

        if before == nil || beforeLines.isEmpty || (beforeLines.count == 1 && beforeLines[0].isEmpty) {
            return afterLines.enumerated().map { i, line in
                DiffLine(id: "add-\(i)", kind: .added, text: line)
            }
        }
        if after == nil || afterLines.isEmpty || (afterLines.count == 1 && afterLines[0].isEmpty) {
            return beforeLines.enumerated().map { i, line in
                DiffLine(id: "rem-\(i)", kind: .removed, text: line)
            }
        }

        var lines: [DiffLine] = []
        var bIdx = 0
        var aIdx = 0

        while bIdx < beforeLines.count || aIdx < afterLines.count {
            if bIdx < beforeLines.count && aIdx < afterLines.count {
                if beforeLines[bIdx] == afterLines[aIdx] {
                    lines.append(DiffLine(id: "eq-\(bIdx)-\(aIdx)", kind: .unchanged, text: beforeLines[bIdx]))
                    bIdx += 1
                    aIdx += 1
                } else {
                    lines.append(DiffLine(id: "rem-\(bIdx)", kind: .removed, text: beforeLines[bIdx]))
                    lines.append(DiffLine(id: "add-\(aIdx)", kind: .added, text: afterLines[aIdx]))
                    bIdx += 1
                    aIdx += 1
                }
            } else if bIdx < beforeLines.count {
                lines.append(DiffLine(id: "rem-\(bIdx)", kind: .removed, text: beforeLines[bIdx]))
                bIdx += 1
            } else {
                lines.append(DiffLine(id: "add-\(aIdx)", kind: .added, text: afterLines[aIdx]))
                aIdx += 1
            }
        }
        return lines
    }
}
