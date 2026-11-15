package dev.harness.mobile.core.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DeepLinkAndPushTest {

    @Test
    fun `parses pair deep link with encoded origin and code`() {
        val target = DeepLinkParser.parse(
            "harness://pair?origin=https%3A%2F%2Fharness.example.com&code=PAIR-999"
        )
        assertTrue(target is DeepLinkTarget.Pair)
        val pair = target as DeepLinkTarget.Pair
        assertEquals("https://harness.example.com", pair.origin)
        assertEquals("PAIR-999", pair.code)
        assertEquals("https://harness.example.com", pair.instanceOrigin)
    }

    @Test
    fun `parses approvals deep link and preserves origin`() {
        val target = DeepLinkParser.parse(
            "harness://approvals/apr_123?origin=http%3A%2F%2F127.0.0.1%3A4100"
        )
        assertEquals(
            DeepLinkTarget.Approval(approvalId = "apr_123", instanceOrigin = "http://127.0.0.1:4100"),
            target
        )
    }

    @Test
    fun `parses runs deep link with override instanceOrigin`() {
        val target = DeepLinkParser.parse(
            uriString = "harness://runs/run_456",
            instanceOriginOverride = "https://prod.harness.dev"
        )
        assertEquals(
            DeepLinkTarget.Run(runId = "run_456", instanceOrigin = "https://prod.harness.dev"),
            target
        )
    }

    @Test
    fun `parses chat deep link with org slug and channel id`() {
        val target = DeepLinkParser.parse("harness://chat/acme/ch_general")
        assertEquals(
            DeepLinkTarget.Chat(orgSlug = "acme", channelId = "ch_general", instanceOrigin = null),
            target
        )
    }

    @Test
    fun `returns null for non-harness or blank uris`() {
        assertNull(DeepLinkParser.parse(null))
        assertNull(DeepLinkParser.parse(""))
        assertNull(DeepLinkParser.parse("https://harness.example.com/approvals/1"))
        assertNull(DeepLinkParser.parse("harness://unknown/123"))
    }

    @Test
    fun `maps push kinds and urgency to expected notification channels`() {
        assertEquals(
            PushNotificationManager.CHANNEL_GUARD_URGENT,
            PushNotificationManager.channelIdFor("approval_requested")
        )
        assertEquals(
            PushNotificationManager.CHANNEL_GUARD_URGENT,
            PushNotificationManager.channelIdFor("run_blocked")
        )
        assertEquals(
            PushNotificationManager.CHANNEL_GUARD_URGENT,
            PushNotificationManager.channelIdFor("custom_alert", urgency = "high")
        )
        assertEquals(
            PushNotificationManager.CHANNEL_ACTIVITY,
            PushNotificationManager.channelIdFor("mention")
        )
        assertEquals(
            PushNotificationManager.CHANNEL_ACTIVITY,
            PushNotificationManager.channelIdFor("dm")
        )
        assertEquals(
            PushNotificationManager.CHANNEL_ACTIVITY,
            PushNotificationManager.channelIdFor("approval_resolved")
        )
    }
}
