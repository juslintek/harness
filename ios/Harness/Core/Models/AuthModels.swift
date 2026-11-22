import Foundation

public struct User: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let email: String
    public let name: String
    public let instanceAdmin: Bool
    public let createdAt: Int64

    public init(
        id: String,
        email: String,
        name: String,
        instanceAdmin: Bool = false,
        createdAt: Int64 = 0
    ) {
        self.id = id
        self.email = email
        self.name = name
        self.instanceAdmin = instanceAdmin
        self.createdAt = createdAt
    }
}

public struct Session: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let method: String
    public let stepUpAt: Int64?
    public let stepUpFresh: Bool?

    public init(
        id: String,
        method: String,
        stepUpAt: Int64? = nil,
        stepUpFresh: Bool? = nil
    ) {
        self.id = id
        self.method = method
        self.stepUpAt = stepUpAt
        self.stepUpFresh = stepUpFresh
    }
}

public struct OrgMembership: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let slug: String
    public let name: String
    public let personal: Bool
    public let createdAt: Int64
    public let role: String

    public init(
        id: String,
        slug: String,
        name: String,
        personal: Bool = false,
        createdAt: Int64 = 0,
        role: String = "member"
    ) {
        self.id = id
        self.slug = slug
        self.name = name
        self.personal = personal
        self.createdAt = createdAt
        self.role = role
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        slug = try c.decode(String.self, forKey: .slug)
        name = try c.decode(String.self, forKey: .name)
        personal = try c.decodeIfPresent(Bool.self, forKey: .personal) ?? false
        createdAt = try c.decodeIfPresent(Int64.self, forKey: .createdAt) ?? 0
        role = try c.decodeIfPresent(String.self, forKey: .role) ?? "member"
    }
}

public struct MobileDevice: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public let platform: String
    public let createdAt: Int64
    public let lastUsedAt: Int64
    public let current: Bool

    public init(
        id: String,
        name: String,
        platform: String,
        createdAt: Int64 = 0,
        lastUsedAt: Int64 = 0,
        current: Bool = false
    ) {
        self.id = id
        self.name = name
        self.platform = platform
        self.createdAt = createdAt
        self.lastUsedAt = lastUsedAt
        self.current = current
    }
}

public struct MeResponse: Codable, Sendable, Equatable {
    public let user: User
    public let session: Session
    public let orgs: [OrgMembership]
    public let devices: [MobileDevice]

    public init(
        user: User,
        session: Session,
        orgs: [OrgMembership],
        devices: [MobileDevice]
    ) {
        self.user = user
        self.session = session
        self.orgs = orgs
        self.devices = devices
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        user = try c.decode(User.self, forKey: .user)
        session = try c.decode(Session.self, forKey: .session)
        orgs = try c.decodeIfPresent([OrgMembership].self, forKey: .orgs) ?? []
        devices = try c.decodeIfPresent([MobileDevice].self, forKey: .devices) ?? []
    }
}

public struct CryptoP256Vector: Codable, Sendable, Equatable {
    public let rpOrigin: String
    public let sessionId: String
    public let challengeId: String
    public let nonce: String
    public let canonicalPayload: String
    public let publicKeySpki: String
    public let signature: String
}

public struct MobileEnrollOptionsRequest: Codable, Sendable {
    public let email: String?
    public let name: String?
    public let deviceName: String
    public let platform: String

    public init(email: String? = nil, name: String? = nil, deviceName: String, platform: String = "ios") {
        self.email = email
        self.name = name
        self.deviceName = deviceName
        self.platform = platform
    }
}

public struct MobileEnrollOptionsResponse: Codable, Sendable {
    public let challengeId: String
    public let nonce: String
    public let userId: String
    public let rpOrigin: String
}

public struct MobileEnrollVerifyRequest: Codable, Sendable {
    public let challengeId: String
    public let userId: String
    public let deviceName: String
    public let platform: String
    public let publicKeySpki: String
    public let signature: String

    public init(challengeId: String, userId: String, deviceName: String, platform: String = "ios", publicKeySpki: String, signature: String) {
        self.challengeId = challengeId
        self.userId = userId
        self.deviceName = deviceName
        self.platform = platform
        self.publicKeySpki = publicKeySpki
        self.signature = signature
    }
}

public struct MobileEnrollVerifyResponse: Codable, Sendable {
    public let token: String
    public let deviceId: String
    public let user: User
    public let recoveryCodes: [String]
}

public struct MobilePairOptionsRequest: Codable, Sendable {
    public let code: String
    public let deviceName: String
    public let platform: String

    public init(code: String, deviceName: String, platform: String = "ios") {
        self.code = code
        self.deviceName = deviceName
        self.platform = platform
    }
}

public struct MobilePairOptionsResponse: Codable, Sendable {
    public let challengeId: String
    public let nonce: String
    public let rpOrigin: String
}

public struct MobilePairVerifyRequest: Codable, Sendable {
    public let challengeId: String
    public let code: String
    public let deviceName: String
    public let platform: String
    public let publicKeySpki: String
    public let signature: String

    public init(challengeId: String, code: String, deviceName: String, platform: String = "ios", publicKeySpki: String, signature: String) {
        self.challengeId = challengeId
        self.code = code
        self.deviceName = deviceName
        self.platform = platform
        self.publicKeySpki = publicKeySpki
        self.signature = signature
    }
}

public struct MobilePairVerifyResponse: Codable, Sendable {
    public let token: String
    public let deviceId: String
    public let user: User
}

public struct MobileStepUpOptionsResponse: Codable, Sendable {
    public let challengeId: String
    public let nonce: String
    public let expiresAt: Int64
}

public struct MobileStepUpVerifyRequest: Codable, Sendable {
    public let challengeId: String
    public let signature: String

    public init(challengeId: String, signature: String) {
        self.challengeId = challengeId
        self.signature = signature
    }
}

public struct MobileStepUpVerifyResponse: Codable, Sendable {
    public let ok: Bool
    public let stepUpAt: Int64
}

public struct HaltRequest: Codable, Sendable {
    public let halted: Bool

    public init(halted: Bool) {
        self.halted = halted
    }
}

public struct HaltResponse: Codable, Sendable {
    public let halted: Bool
}

public struct MobilePushSubscribeRequest: Codable, Sendable {
    public let relayUrl: String
    public let platform: String
    public let appId: String
    public let pushToken: String
    public let relaySecret: String?

    public init(relayUrl: String, platform: String = "ios", appId: String, pushToken: String, relaySecret: String? = nil) {
        self.relayUrl = relayUrl
        self.platform = platform
        self.appId = appId
        self.pushToken = pushToken
        self.relaySecret = relaySecret
    }
}

public struct APIErrorResponse: Codable, Sendable {
    public let error: String
    public let status: Int?
}
