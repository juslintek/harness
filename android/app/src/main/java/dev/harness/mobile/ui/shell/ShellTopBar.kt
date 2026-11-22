package dev.harness.mobile.ui.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.harness.mobile.core.model.OrgView
import dev.harness.mobile.core.store.InstanceConfig
import dev.harness.mobile.theme.HairlineDivider
import dev.harness.mobile.theme.StudioNorthTheme

@Composable
internal fun ShellTopBar(
    activeInstance: InstanceConfig,
    instances: List<InstanceConfig>,
    activeOrg: OrgView?,
    orgs: List<OrgView>,
    isInstanceAdmin: Boolean,
    isHalted: Boolean,
    onSelectInstance: (String) -> Unit,
    onSelectOrg: (String) -> Unit,
    onOpenHaltDialog: () -> Unit
) {
    val colors = StudioNorthTheme.colors
    var showInstanceMenu by remember { mutableStateOf(false) }
    var showOrgMenu by remember { mutableStateOf(false) }

    Column(modifier = Modifier.fillMaxWidth().background(colors.surface)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box {
                    Box(
                        modifier = Modifier
                            .defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
                            .clip(RoundedCornerShape(StudioNorthTheme.radius24))
                            .border(1.dp, colors.border, RoundedCornerShape(StudioNorthTheme.radius24))
                            .clickable { showInstanceMenu = true }
                            .padding(horizontal = 10.dp, vertical = 6.dp)
                            .testTag("button.instance_switcher")
                            .semantics { contentDescription = "Switch instance: ${activeInstance.name}" },
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            text = activeInstance.name,
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Medium,
                            color = colors.ink,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                    }
                    DropdownMenu(
                        expanded = showInstanceMenu,
                        onDismissRequest = { showInstanceMenu = false }
                    ) {
                        instances.forEach { inst ->
                            DropdownMenuItem(
                                text = { Text(inst.name) },
                                onClick = {
                                    onSelectInstance(inst.id)
                                    showInstanceMenu = false
                                }
                            )
                        }
                    }
                }

                Spacer(modifier = Modifier.width(8.dp))

                Box {
                    Box(
                        modifier = Modifier
                            .defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
                            .clip(RoundedCornerShape(StudioNorthTheme.radius24))
                            .border(1.dp, colors.border, RoundedCornerShape(StudioNorthTheme.radius24))
                            .clickable { showOrgMenu = true }
                            .padding(horizontal = 10.dp, vertical = 6.dp)
                            .testTag("button.org_switcher")
                            .semantics { contentDescription = "Switch organization: ${activeOrg?.name ?: "Org"}" },
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            text = activeOrg?.name ?: "Org",
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Medium,
                            color = colors.ink,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                    }
                    DropdownMenu(
                        expanded = showOrgMenu,
                        onDismissRequest = { showOrgMenu = false }
                    ) {
                        orgs.forEach { org ->
                            DropdownMenuItem(
                                text = { Text(org.name) },
                                onClick = {
                                    onSelectOrg(org.id)
                                    showOrgMenu = false
                                }
                            )
                        }
                    }
                }
            }

            if (isInstanceAdmin) {
                Box(
                    modifier = Modifier
                        .defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
                        .clip(RoundedCornerShape(StudioNorthTheme.radius24))
                        .background(if (isHalted) colors.danger else colors.surfaceRaised)
                        .border(1.dp, if (isHalted) colors.danger else colors.border, RoundedCornerShape(StudioNorthTheme.radius24))
                        .clickable { onOpenHaltDialog() }
                        .padding(horizontal = 12.dp, vertical = 6.dp)
                        .testTag("button.halt")
                        .semantics {
                            contentDescription = if (isHalted) "Resume instance" else "Halt instance"
                        },
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = if (isHalted) "RESUME" else "HALT",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                        color = if (isHalted) colors.onBrand else colors.danger
                    )
                }
            }
        }
        HairlineDivider()
    }
}
