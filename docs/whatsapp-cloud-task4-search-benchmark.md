# WhatsApp Cloud Task 4 search benchmark

Validated on October 8, 2026 with the executable PostgreSQL gate in `tests/whatsapp-cloud-inbox-admin-postgres.test.js`.

Search semantics:

- Queries are trimmed and accept 2–80 characters.
- Exactly two characters use a normalized, case-insensitive **prefix** match for customer name and delivery address. This is consistent for both fields and uses tenant-first `text_pattern_ops` expression indexes.
- Queries of three or more characters use one tenant-prefixed normalized name/address expression through `idx_puntos_entrega_whatsapp_search_text_tenant_trgm`; this avoids requiring `btree_gin` while keeping the trigram lookup tenant-selective.
- Eligible phone suffix and public-order matches are unioned with text matches; none of the branches truncates candidates before canonical queue ordering, cursor filtering, or final page limiting.

The executable gate builds a representative two-tenant fixture and runs `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` against the exact SQL captured from `listCloudConversations`. It covers two-character prefix, tenant-prefixed trigram text, phone, and order paths with the normal planner. Candidate conversations are materialized before latest-message, inbound/unread, and customer hydration work. The gate rejects correlated `SubPlan`, array-based candidate transport, arbitrary `LIMIT 500`, and message scans whose actual rows show global tenant history work; it also checks the expected lookup indexes and finite planner cost without a latency threshold.

Conversation context is resolved by one PostgreSQL statement: conversation, phone cardinality, exact customer, and recent orders share one statement snapshot. The order CTE is empty unless cardinality is exactly one, and ambiguous/none responses cannot carry customer or financial fields.

The >500-match integration fixture separately verifies that an urgent conversation outside telephone order is returned first and that cursor pagination reaches every matching conversation exactly once.
