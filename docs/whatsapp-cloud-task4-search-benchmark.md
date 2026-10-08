# WhatsApp Cloud Task 4 search benchmark

Validated on October 7, 2026 with the executable PostgreSQL gate in `tests/whatsapp-cloud-inbox-admin-postgres.test.js`.

Search semantics:

- Queries are trimmed and accept 2–80 characters.
- Exactly two characters use a normalized, case-insensitive **prefix** match for customer name and delivery address. This is consistent for both fields and uses tenant-first `text_pattern_ops` expression indexes.
- Queries of three or more characters use case-insensitive substring matching through the `pg_trgm` expression indexes.
- Eligible phone suffix and public-order matches are unioned with text matches; none of the branches truncates candidates before canonical queue ordering, cursor filtering, or final page limiting.

The executable gate builds a representative fixture and runs `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` against the exact SQL captured from `listCloudConversations`. It covers two-character prefix, trigram text, phone, and order paths with the normal planner. The gate rejects correlated `SubPlan`, array-based candidate transport, and arbitrary `LIMIT 500`, checks the expected lookup indexes, and requires a finite planner cost without a latency threshold.

The >500-match integration fixture separately verifies that an urgent conversation outside telephone order is returned first and that cursor pagination reaches every matching conversation exactly once.
