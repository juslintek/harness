package dev.harness.mobile.features.chat

import dev.harness.mobile.core.model.ChatMember

object MentionUtils {
    private val MENTION_TRAILING_REGEX = Regex("""(?:^|[\s,;!?:])@([a-zA-Z0-9_-]*)$""")

    /**
     * Extracts the mention query string (without '@') if the caret is immediately after a mention prefix.
     * Returns null if no active mention token is being typed before the caret.
     */
    fun extractMentionQuery(text: String, caretPosition: Int): String? {
        if (caretPosition < 0 || caretPosition > text.length) return null
        val beforeCaret = text.substring(0, caretPosition)
        val match = MENTION_TRAILING_REGEX.find(beforeCaret) ?: return null
        return match.groupValues[1]
    }

    /**
     * Filters members whose handle or displayName matches the query.
     */
    fun filterMembers(members: List<ChatMember>, query: String, limit: Int = 8): List<ChatMember> {
        val q = query.trim().lowercase()
        return members
            .filter { member ->
                member.handle.lowercase().startsWith(q) ||
                member.displayName.lowercase().contains(q)
            }
            .take(limit)
    }

    /**
     * Inserts the chosen member's handle, replacing the trailing '@query' before the caret.
     * Returns Pair<newText, newCaretPosition>.
     */
    fun insertMention(text: String, caretPosition: Int, member: ChatMember): Pair<String, Int> {
        val safeCaret = caretPosition.coerceIn(0, text.length)
        val beforeCaret = text.substring(0, safeCaret)
        val afterCaret = text.substring(safeCaret)

        val match = MENTION_TRAILING_REGEX.find(beforeCaret)
        return if (match != null) {
            val mentionStartIndex = match.range.first + (if (match.value.startsWith("@")) 0 else 1)
            val prefix = text.substring(0, mentionStartIndex)
            val replacement = "@${member.handle} "
            val newText = prefix + replacement + afterCaret
            val newCaret = prefix.length + replacement.length
            Pair(newText, newCaret)
        } else {
            val replacement = "@${member.handle} "
            Pair(beforeCaret + replacement + afterCaret, safeCaret + replacement.length)
        }
    }
}
