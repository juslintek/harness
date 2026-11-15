package dev.harness.mobile.features.workspace

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.harness.mobile.core.store.InstanceConfig
import dev.harness.mobile.theme.HairlineDivider
import dev.harness.mobile.theme.RaisedCard
import dev.harness.mobile.theme.StudioNorthTheme

@Composable
fun AccountSection(
    state: AccountState,
    onTogglePref: (String, String) -> Unit,
    onRevokeDevice: (String) -> Unit,
    onRegisterPush: (String, String) -> Unit,
    instances: List<InstanceConfig>,
    activeInstance: InstanceConfig?,
    onSelectInstance: (String) -> Unit,
    onAddInstance: (String, String) -> Unit,
    onRemoveInstance: (String) -> Unit,
    isInstanceAdmin: Boolean,
    instanceOrigin: String,
    orgSlug: String,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val colors = StudioNorthTheme.colors
    var showAddInstanceDialog by remember { mutableStateOf(false) }
    var showPushDialog by remember { mutableStateOf(false) }

    LazyColumn(
        modifier = modifier.fillMaxSize().padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
        contentPadding = PaddingValues(vertical = 12.dp)
    ) {
        // 25-Cell Notification Preference Matrix
        item {
            Text(
                text = "Notification Preferences (5×5 Matrix)",
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold,
                color = colors.ink
            )
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = "Choose channels for each notification type",
                fontSize = 12.sp,
                color = colors.inkMuted
            )
            Spacer(modifier = Modifier.height(8.dp))
            NotificationMatrix(state = state, onTogglePref = onTogglePref)
        }

        // Push Targets Section
        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "Notification Targets (${state.targets.size})",
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Bold,
                    color = colors.ink
                )
                Text(
                    text = "+ Register Push",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    color = colors.link,
                    modifier = Modifier.clickable { showPushDialog = true }.padding(4.dp)
                )
            }
            Spacer(modifier = Modifier.height(6.dp))
            if (state.targets.isEmpty()) {
                RaisedCard(modifier = Modifier.fillMaxWidth()) {
                    Text(text = "No notification targets registered.", fontSize = 12.sp, color = colors.inkMuted)
                }
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    state.targets.forEach { target ->
                        RaisedCard(modifier = Modifier.fillMaxWidth()) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text(text = target.label, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = colors.ink)
                                Box(
                                    modifier = Modifier
                                        .clip(CircleShape)
                                        .background(colors.surface)
                                        .border(1.dp, colors.border, CircleShape)
                                        .padding(horizontal = 8.dp, vertical = 2.dp)
                                ) {
                                    Text(text = target.channel, fontSize = 11.sp, color = colors.inkMuted)
                                }
                            }
                        }
                    }
                }
            }
        }

        // Paired Devices Section
        item {
            Text(
                text = "Paired Mobile Devices (${state.devices.size})",
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold,
                color = colors.ink
            )
            Spacer(modifier = Modifier.height(6.dp))
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                state.devices.forEach { device ->
                    RaisedCard(modifier = Modifier.fillMaxWidth()) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Column {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(text = device.name, fontSize = 14.sp, fontWeight = FontWeight.Bold, color = colors.ink)
                                    if (device.current) {
                                        Spacer(modifier = Modifier.width(6.dp))
                                        Box(
                                            modifier = Modifier
                                                .clip(CircleShape)
                                                .background(colors.accent.copy(alpha = 0.3f))
                                                .padding(horizontal = 6.dp, vertical = 2.dp)
                                        ) {
                                            Text(text = "current", fontSize = 10.sp, fontWeight = FontWeight.Bold, color = colors.brand)
                                        }
                                    }
                                }
                                Text(text = "Platform: ${device.platform.uppercase()}", fontSize = 12.sp, color = colors.inkMuted)
                            }
                            if (!device.current) {
                                Text(
                                    text = "Revoke",
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.Bold,
                                    color = colors.danger,
                                    modifier = Modifier.clickable { onRevokeDevice(device.id) }.padding(6.dp)
                                )
                            }
                        }
                    }
                }
            }
        }

        // Multi-Instance Switcher
        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "Server Instances (${instances.size})",
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Bold,
                    color = colors.ink
                )
                Text(
                    text = "+ Add Instance",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    color = colors.link,
                    modifier = Modifier.clickable { showAddInstanceDialog = true }.padding(4.dp)
                )
            }
            Spacer(modifier = Modifier.height(6.dp))
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                instances.forEach { inst ->
                    val isActive = inst.id == activeInstance?.id
                    RaisedCard(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onSelectInstance(inst.id) }
                            .border(
                                1.dp,
                                if (isActive) colors.brand else colors.border,
                                RoundedCornerShape(StudioNorthTheme.radius12)
                            )
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Column {
                                Text(text = inst.name, fontSize = 13.sp, fontWeight = FontWeight.Bold, color = colors.ink)
                                Text(text = inst.originUrl, fontSize = 11.sp, color = colors.inkMuted)
                            }
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                if (isActive) {
                                    Box(
                                        modifier = Modifier
                                            .clip(CircleShape)
                                            .background(colors.brand)
                                            .padding(horizontal = 8.dp, vertical = 2.dp)
                                    ) {
                                        Text(text = "Active", fontSize = 10.sp, fontWeight = FontWeight.Bold, color = colors.onBrand)
                                    }
                                } else {
                                    Text(
                                        text = "Remove",
                                        fontSize = 11.sp,
                                        fontWeight = FontWeight.Bold,
                                        color = colors.danger,
                                        modifier = Modifier
                                            .clickable { onRemoveInstance(inst.id) }
                                            .padding(4.dp)
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }

        // Admin Web Handoff
        item {
            Text(
                text = "Web Admin Handoff",
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold,
                color = colors.ink
            )
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = "Open full management portals in web browser",
                fontSize = 12.sp,
                color = colors.inkMuted
            )
            Spacer(modifier = Modifier.height(8.dp))

            RaisedCard(modifier = Modifier.fillMaxWidth()) {
                Text(text = "Organization Portals", fontSize = 13.sp, fontWeight = FontWeight.Bold, color = colors.ink)
                Spacer(modifier = Modifier.height(6.dp))
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    AdminHandoffHelper.ORG_SECTIONS.forEach { (section, title) ->
                        val url = AdminHandoffHelper.buildOrgUrl(instanceOrigin, orgSlug, section)
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(8.dp))
                                .clickable { AdminHandoffHelper.openBrowser(context, url) }
                                .padding(vertical = 4.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(text = title, fontSize = 13.sp, color = colors.ink)
                            Text(text = "↗", fontSize = 14.sp, fontWeight = FontWeight.Bold, color = colors.link)
                        }
                    }
                }

                if (isInstanceAdmin) {
                    Spacer(modifier = Modifier.height(10.dp))
                    HairlineDivider()
                    Spacer(modifier = Modifier.height(10.dp))
                    Text(text = "Instance Administration", fontSize = 13.sp, fontWeight = FontWeight.Bold, color = colors.ink)
                    Spacer(modifier = Modifier.height(6.dp))
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        AdminHandoffHelper.INSTANCE_ADMIN_SECTIONS.forEach { (section, title) ->
                            val url = AdminHandoffHelper.buildAdminUrl(instanceOrigin, section)
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(8.dp))
                                    .clickable { AdminHandoffHelper.openBrowser(context, url) }
                                    .padding(vertical = 4.dp),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text(text = title, fontSize = 13.sp, color = colors.ink)
                                Text(text = "↗", fontSize = 14.sp, fontWeight = FontWeight.Bold, color = colors.link)
                            }
                        }
                    }
                }
            }
        }
    }

    if (showAddInstanceDialog) {
        AddInstanceDialog(
            onDismiss = { showAddInstanceDialog = false },
            onConfirm = { name, url ->
                onAddInstance(name, url)
                showAddInstanceDialog = false
            }
        )
    }

    if (showPushDialog) {
        RegisterPushDialog(
            onDismiss = { showPushDialog = false },
            onConfirm = { url, token ->
                onRegisterPush(url, token)
                showPushDialog = false
            }
        )
    }
}
