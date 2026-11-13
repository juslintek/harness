-- Binding a request to a sender rests on one live public key per peer, so two active peers must
-- never share a key. Where old rows already do, the earliest pairing keeps its trust and the
-- later copies are revoked, not deleted: the UI still lists them and nothing is silently lost.
UPDATE peers SET revoked_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE revoked_at IS NULL
  AND EXISTS (
    SELECT 1 FROM peers other
    WHERE other.public_key = peers.public_key AND other.revoked_at IS NULL
      AND (other.paired_at < peers.paired_at
        OR (other.paired_at = peers.paired_at AND other.id < peers.id))
  );

CREATE UNIQUE INDEX peers_active_public_key ON peers (public_key) WHERE revoked_at IS NULL;
