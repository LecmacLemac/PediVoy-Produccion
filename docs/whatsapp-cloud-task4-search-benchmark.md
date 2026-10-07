# WhatsApp Cloud Task 4 search benchmark

Measured on October 7, 2026 with PostgreSQL using 100,000 delivery points, 100,000 tenant-scoped conversations, and 20,000 orders.

Query: operational customer-name search using the same `candidate_points` union and tenant/phone-suffix join as `searchCloudConversations`.

Observed `EXPLAIN (ANALYZE, BUFFERS)`:

- Execution time: 3.676 ms.
- Customer name: `Bitmap Index Scan` on `idx_puntos_entrega_whatsapp_search_name_trgm`.
- Address: `Bitmap Index Scan` on `idx_puntos_entrega_whatsapp_search_address_trgm`.
- Conversation resolution: `Index Scan` on `idx_whatsapp_cloud_conversations_phone_suffix`.
- Point lookup: primary-key index scan.
- No correlated `SubPlan`; phone and order branches with null parameters were removed by one-time filters.

This is an engineering sanity check, not a latency SLO. It verifies that representative cardinality does not force full-table `%LIKE%` scans or a correlated per-conversation lookup.
