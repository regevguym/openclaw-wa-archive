#!/usr/bin/env bash
# migrate-chat-metadata.sh — Fix chat_type and sender_name for existing records
# 
# Fixes:
#   1. chat_type: 'direct' → 'group' for @g.us chat IDs
#   2. sender_name: 'Me' → configured bot name for outbound messages
#
# Usage:
#   bash scripts/migrate-chat-metadata.sh [DB_PATH] [BOT_NAME]
#
# Examples:
#   bash scripts/migrate-chat-metadata.sh ~/.openclaw/data/wa-archive/messages.db Nymeria
#   bash scripts/migrate-chat-metadata.sh ~/.openclaw/data/wa-archive/messages.db "Mandy Monday"

set -euo pipefail

DB_PATH="${1:-$HOME/.openclaw/data/wa-archive/messages.db}"
BOT_NAME="${2:-}"

if [ ! -f "$DB_PATH" ]; then
  echo "❌ Database not found: $DB_PATH"
  exit 1
fi

if [ -z "$BOT_NAME" ]; then
  echo "❌ Bot name required. Usage: $0 [DB_PATH] BOT_NAME"
  exit 1
fi

echo "🔧 WA Archive Migration — chat_type & sender_name fix"
echo "   DB: $DB_PATH"
echo "   Bot name: $BOT_NAME"
echo ""

# Backup first
BACKUP_PATH="${DB_PATH}.bak.$(date +%Y%m%d%H%M%S)"
cp "$DB_PATH" "$BACKUP_PATH"
echo "📦 Backup created: $BACKUP_PATH"

# Drop FTS triggers temporarily (they block UPDATE on non-content columns)
sqlite3 "$DB_PATH" "
  DROP TRIGGER IF EXISTS messages_au;
  DROP TRIGGER IF EXISTS messages_ad;
  DROP TRIGGER IF EXISTS messages_ai;
"
echo "🔧 FTS triggers dropped temporarily"

# Fix 1: chat_type for group chats
GROUPS_FIXED=$(sqlite3 "$DB_PATH" "
  UPDATE messages 
  SET chat_type = 'group' 
  WHERE chat_id LIKE '%@g.us' AND chat_type = 'direct';
  SELECT changes();
")
echo "✅ Fix 1: chat_type — $GROUPS_FIXED group messages fixed (direct → group)"

# Fix 2: sender_name for outbound messages
SENDER_FIXED=$(sqlite3 "$DB_PATH" "
  UPDATE messages 
  SET sender_name = '$BOT_NAME' 
  WHERE direction = 'outbound' AND (sender_name = 'Me' OR sender_name IS NULL);
  SELECT changes();
")
echo "✅ Fix 2: sender_name — $SENDER_FIXED outbound messages fixed (Me → $BOT_NAME)"

# Recreate FTS triggers
sqlite3 "$DB_PATH" "
  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
  END;
"
echo "🔧 FTS triggers restored"

# Verify
echo ""
echo "📊 Verification:"
sqlite3 "$DB_PATH" "
  SELECT 'chat_type distribution:' as '';
  SELECT chat_type, count(*) as cnt FROM messages GROUP BY chat_type;
  SELECT '';
  SELECT 'outbound sender_name distribution:' as '';
  SELECT sender_name, count(*) as cnt FROM messages WHERE direction='outbound' GROUP BY sender_name;
"

echo ""
echo "✅ Migration complete!"
echo "   Backup at: $BACKUP_PATH"
echo "   (Delete backup after verifying: rm $BACKUP_PATH)"
