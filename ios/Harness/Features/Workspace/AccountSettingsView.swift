import SwiftUI

public struct AccountSettingsView: View {
    @Bindable var store: AccountStore
    @State private var newRelayUrl: String = ""
    @State private var newPushToken: String = ""
    @State private var isAddingTarget: Bool = false

    public init(store: AccountStore) {
        self.store = store
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                // Instance Switcher
                instanceSection

                // 25-Toggle Notification Matrix
                notificationMatrixSection

                // Push Relay Configuration & Targets
                pushRelaySection

                // Paired Mobile Devices
                pairedDevicesSection
            }
            .padding(.horizontal)
            .padding(.vertical, 12)
        }
        .task {
            await store.loadPrefs()
            await store.loadTargets()
            await store.loadDevices()
        }
    }

    // MARK: - Instance Switcher
    private var instanceSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Active Instance")
                .font(.headline)
                .foregroundStyle(StudioNorthTheme.ink)

            if let sessionStore = store.sessionStore {
                ForEach(sessionStore.instances) { instance in
                    let isActive = sessionStore.activeInstanceId == instance.id
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(instance.origin)
                                .font(.subheadline.weight(isActive ? .bold : .regular))
                                .foregroundStyle(StudioNorthTheme.ink)
                            Text("User: \(instance.user.email) (\(instance.selectedOrgSlug))")
                                .font(.caption)
                                .foregroundStyle(StudioNorthTheme.inkMuted)
                        }
                        Spacer()
                        if isActive {
                            StatusBadge(text: "Active", color: StudioNorthTheme.link)
                        } else {
                            Button("Switch") {
                                store.switchInstance(to: instance.id)
                            }
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(StudioNorthTheme.link)
                        }

                        if sessionStore.instances.count > 1 {
                            Button(role: .destructive) {
                                store.removeInstance(id: instance.id)
                            } label: {
                                Image(systemName: "trash")
                                    .font(.caption)
                                    .foregroundStyle(StudioNorthTheme.danger)
                            }
                            .padding(.leading, 8)
                        }
                    }
                    .padding(12)
                    .background(StudioNorthTheme.surfaceRaised)
                    .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm))
                }
            }
        }
    }

    // MARK: - 25-Toggle Notification Matrix
    private var notificationMatrixSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Notification Preferences")
                .font(.headline)
                .foregroundStyle(StudioNorthTheme.ink)

            Text("Matrix across 5 channels × 5 event kinds")
                .font(.caption)
                .foregroundStyle(StudioNorthTheme.inkMuted)

            VStack(spacing: 8) {
                ForEach(NotificationKind.allCases, id: \.rawValue) { kind in
                    RaisedCard {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(kind.label)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(StudioNorthTheme.ink)

                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 8) {
                                    ForEach(NotificationChannel.allCases, id: \.rawValue) { channel in
                                        let enabled = store.isEnabled(channel: channel, kind: kind)
                                        Button {
                                            Task {
                                                await store.togglePref(channel: channel, kind: kind)
                                            }
                                        } label: {
                                            HStack(spacing: 4) {
                                                Image(systemName: enabled ? "checkmark.circle.fill" : "circle")
                                                    .font(.caption2)
                                                Text(channel.label)
                                                    .font(.caption)
                                            }
                                            .foregroundStyle(enabled ? StudioNorthTheme.onBrand : StudioNorthTheme.ink)
                                            .padding(.horizontal, 8)
                                            .padding(.vertical, 4)
                                            .background(enabled ? StudioNorthTheme.brand : StudioNorthTheme.surface)
                                            .clipShape(Capsule())
                                            .overlay(
                                                Capsule()
                                                    .stroke(StudioNorthTheme.border, lineWidth: 1)
                                            )
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - Push Relay & Targets
    private var pushRelaySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Push Targets & Relay")
                    .font(.headline)
                    .foregroundStyle(StudioNorthTheme.ink)
                Spacer()
                Button {
                    if newPushToken.isEmpty, let apnsHex = PushRegistrationManager.shared.deviceTokenHex {
                        newPushToken = apnsHex
                    }
                    isAddingTarget.toggle()
                } label: {
                    Image(systemName: "plus.circle")
                        .foregroundStyle(StudioNorthTheme.link)
                }
                .accessibilityLabel("Add push target")
                .accessibilityIdentifier("workspace.push.add")
            }

            if isAddingTarget {
                VStack(spacing: 8) {
                    TextField("Relay URL (e.g. https://relay.example.com)", text: $newRelayUrl)
                        .textFieldStyle(.roundedBorder)
                        .accessibilityIdentifier("workspace.push.relayUrl")
                    TextField("Push Token", text: $newPushToken)
                        .textFieldStyle(.roundedBorder)
                        .accessibilityIdentifier("workspace.push.token")

                    Button("Register Push Target") {
                        Task {
                            _ = await PushRegistrationManager.shared.requestAuthorizationAndRegister()
                            try? await store.registerPushTarget(
                                relayUrl: newRelayUrl,
                                appId: "dev.harness.mobile",
                                pushToken: newPushToken
                            )
                            isAddingTarget = false
                            newRelayUrl = ""
                            newPushToken = ""
                        }
                    }
                    .accessibilityIdentifier("workspace.push.register")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(StudioNorthTheme.onBrand)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(StudioNorthTheme.brand)
                    .clipShape(Capsule())
                }
                .padding(10)
                .background(StudioNorthTheme.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm))
            }

            if store.targets.isEmpty {
                Text("No push targets registered.")
                    .font(.caption)
                    .foregroundStyle(StudioNorthTheme.inkMuted)
            } else {
                ForEach(store.targets) { target in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(target.channel.capitalized)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(StudioNorthTheme.ink)
                            Text(target.label ?? target.id)
                                .font(.caption.monospaced())
                                .foregroundStyle(StudioNorthTheme.inkMuted)
                        }
                        Spacer()
                        Button(role: .destructive) {
                            Task { try? await store.deleteTarget(id: target.id) }
                        } label: {
                            Image(systemName: "trash")
                                .foregroundStyle(StudioNorthTheme.danger)
                        }
                    }
                    .padding(10)
                    .background(StudioNorthTheme.surfaceRaised)
                    .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm))
                }
            }
        }
    }

    // MARK: - Paired Devices
    private var pairedDevicesSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Paired Mobile Devices")
                .font(.headline)
                .foregroundStyle(StudioNorthTheme.ink)

            if store.devices.isEmpty {
                Text("No paired devices found.")
                    .font(.caption)
                    .foregroundStyle(StudioNorthTheme.inkMuted)
            } else {
                ForEach(store.devices) { device in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(device.name)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(StudioNorthTheme.ink)
                                if device.current {
                                    StatusBadge(text: "Current", color: StudioNorthTheme.link)
                                }
                            }
                            Text("Platform: \(device.platform.uppercased())")
                                .font(.caption)
                                .foregroundStyle(StudioNorthTheme.inkMuted)
                        }
                        Spacer()
                        Button(role: .destructive) {
                            Task { try? await store.revokeDevice(id: device.id) }
                        } label: {
                            Text("Revoke")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(StudioNorthTheme.danger)
                        }
                    }
                    .padding(10)
                    .background(StudioNorthTheme.surfaceRaised)
                    .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm))
                }
            }
        }
    }
}
