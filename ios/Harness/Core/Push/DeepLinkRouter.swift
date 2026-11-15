import Foundation

public enum DeepLinkTarget: Equatable, Sendable {
    case pair(origin: String?, code: String?)
    case approval(id: String?)
    case run(id: String?)
    case chat(slug: String?, channelId: String?)
    case board
    case workspace
    case open(path: String)
    case tab(AppTab)

    public var tab: AppTab? {
        switch self {
        case .pair: return nil
        case .approval: return .approvals
        case .run: return .runs
        case .chat: return .chat
        case .board: return .board
        case .workspace, .open: return .workspace
        case .tab(let tab): return tab
        }
    }
}

public struct ParsedDeepLink: Equatable, Sendable {
    public let target: DeepLinkTarget
    public let instanceOrigin: String?
    public let rawURL: URL

    public init(target: DeepLinkTarget, instanceOrigin: String?, rawURL: URL) {
        self.target = target
        self.instanceOrigin = instanceOrigin
        self.rawURL = rawURL
    }
}

public enum DeepLinkRouter {
    public static func parse(_ url: URL, instanceOriginHint: String? = nil) -> ParsedDeepLink? {
        guard url.scheme?.lowercased() == "harness" else { return nil }

        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let queryItems = components?.queryItems ?? []
        func query(_ name: String) -> String? {
            queryItems.first(where: { $0.name == name })?.value?.nilIfEmpty
        }

        let originHint = query("instanceOrigin") ?? query("origin") ?? instanceOriginHint?.nilIfEmpty
        let host = url.host?.lowercased()
        let pathParts = url.path
            .split(separator: "/", omittingEmptySubsequences: true)
            .map(String.init)

        if host == "pair" || pathParts.first?.lowercased() == "pair" {
            let target = DeepLinkTarget.pair(origin: query("origin"), code: query("code"))
            return ParsedDeepLink(target: target, instanceOrigin: originHint, rawURL: url)
        }

        if host == "open" || pathParts.first?.lowercased() == "open" {
            if let openPath = query("path") {
                let target = parseOpenPath(openPath, queryId: query("id"))
                return ParsedDeepLink(target: target, instanceOrigin: originHint, rawURL: url)
            }
        }

        if let target = parseRoute(host: host, pathParts: pathParts, queryId: query("id"), querySlug: query("slug"), queryChannelId: query("channelId"), queryTab: query("tab")) {
            return ParsedDeepLink(target: target, instanceOrigin: originHint, rawURL: url)
        }

        return nil
    }

    public static func normalizeOrigin(_ origin: String) -> String {
        var trimmed = origin.trimmingCharacters(in: .whitespacesAndNewlines)
        while trimmed.hasSuffix("/") {
            trimmed.removeLast()
        }
        return trimmed.lowercased()
    }

    public static func matchingInstance(for origin: String?, in instances: [InstanceRecord]) -> InstanceRecord? {
        guard let origin = origin?.nilIfEmpty else { return nil }
        let normalizedTarget = normalizeOrigin(origin)
        return instances.first { normalizeOrigin($0.origin) == normalizedTarget }
    }

    private static func parseOpenPath(_ rawPath: String, queryId: String?) -> DeepLinkTarget {
        let trimmedPath = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = trimmedPath
            .split(separator: "/", omittingEmptySubsequences: true)
            .map(String.init)

        guard let head = parts.first?.lowercased() else {
            return .open(path: trimmedPath)
        }
        let tail = Array(parts.dropFirst())
        if let route = parseRoute(host: head, pathParts: tail, queryId: queryId, querySlug: nil, queryChannelId: nil, queryTab: nil) {
            return route
        }
        return .open(path: trimmedPath)
    }

    private static func parseRoute(
        host: String?,
        pathParts: [String],
        queryId: String?,
        querySlug: String?,
        queryChannelId: String?,
        queryTab: String?
    ) -> DeepLinkTarget? {
        switch host {
        case "approvals", "approval":
            let id = pathParts.first ?? queryId
            return .approval(id: id)

        case "runs", "run":
            let id = pathParts.first ?? queryId
            return .run(id: id)

        case "chat":
            if pathParts.count >= 2 {
                return .chat(slug: pathParts[0], channelId: pathParts[1])
            } else if pathParts.count == 1 {
                return .chat(slug: querySlug, channelId: pathParts[0])
            } else {
                return .chat(slug: querySlug, channelId: queryChannelId)
            }

        case "board":
            return .board

        case "workspace":
            return .workspace

        default:
            if let first = pathParts.first?.lowercased(),
               let route = parseRoute(
                   host: first,
                   pathParts: Array(pathParts.dropFirst()),
                   queryId: queryId,
                   querySlug: querySlug,
                   queryChannelId: queryChannelId,
                   queryTab: nil
               ) {
                return route
            }
            if let queryTab, let tab = AppTab(rawValue: queryTab) {
                return .tab(tab)
            }
            return nil
        }
    }
}

private extension String {
    var nilIfEmpty: String? {
        isEmpty ? nil : self
    }
}
