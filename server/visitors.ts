import { z } from "zod";

// ---------------------------------------------------------------------------
// Visitor page-view admin actions. `visitor_page_views` is a standalone,
// anonymous analytics table: no other table references it, so deletes need no
// cascade. The primary use case is clearing out large volumes of no-data
// anonymous rows, so we support both a targeted bulk delete (by id) and a
// "clear all" convenience action. Kept dependency-free so the request schema
// can be unit-tested directly.
// ---------------------------------------------------------------------------

// Body accepted by POST /api/admin/visitors/bulk-delete: a non-empty list of
// unique positive integer ids. Same shape/limits as the contacts bulk-delete.
export const bulkDeleteVisitorsSchema = z
  .object({
    ids: z.array(z.number().int().positive()).min(1).max(5000),
  })
  .strict();

export type BulkDeleteVisitors = z.infer<typeof bulkDeleteVisitorsSchema>;
