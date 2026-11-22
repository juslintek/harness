import Foundation

public struct InstanceRecord: Codable, Sendable, Identifiable, Equatable {
    public let id: String
    public var origin: String
    public var deviceId: String
    public var user: User
    public var orgs: [OrgMembership]
    public var selectedOrgSlug: String
    public var sessionId: String?

    public init(
        id: String,
        origin: String,
        deviceId: String,
        user: User,
        orgs: [OrgMembership],
        selectedOrgSlug: String,
        sessionId: String? = nil
    ) {
        self.id = id
        self.origin = origin
        self.deviceId = deviceId
        self.user = user
        self.orgs = orgs
        self.selectedOrgSlug = selectedOrgSlug
        self.sessionId = sessionId
    }
}

public final class InstanceRegistry: @unchecked Sendable {
    public static let shared = InstanceRegistry()

    private let userDefaults: UserDefaults
    private let key = "dev.harness.instances"

    public init(userDefaults: UserDefaults = .standard) {
        self.userDefaults = userDefaults
    }

    public func loadInstances() -> [InstanceRecord] {
        guard let data = userDefaults.data(forKey: key),
              let list = try? JSONDecoder().decode([InstanceRecord].self, from: data) else {
            return []
        }
        return list
    }

    public func saveInstances(_ instances: [InstanceRecord]) {
        if let data = try? JSONEncoder().encode(instances) {
            userDefaults.set(data, forKey: key)
        }
    }

    public func addOrUpdateInstance(_ instance: InstanceRecord) {
        var list = loadInstances()
        if let idx = list.firstIndex(where: { $0.id == instance.id }) {
            list[idx] = instance
        } else {
            list.append(instance)
        }
        saveInstances(list)
    }

    public func removeInstance(id: String) {
        var list = loadInstances()
        list.removeAll(where: { $0.id == id })
        saveInstances(list)
    }
}
