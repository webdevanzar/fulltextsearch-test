import { PrismaClient } from "@prisma/client";
import { BenchResult, explainIndexes, printExplainAnalyze, printSummaryTable, runBenchmark, RUNS } from "./lib/bench";

const prisma = new PrismaClient();

// ============================================================================
// EAV counterpart to src/search-analysis.ts — same 7-row structure, same
// scenarios, run against the fully independent EAV table set instead of
// JSONB. Merged from what used to be eav-benchmark.ts + eav-complex-search.ts.
// ============================================================================

const FTS_TERM = "Silver";
const BRAND = "Toyota";
const MIN_YEAR = 2020;

async function main() {
  const motorsCategory = await prisma.eavCategory.findUniqueOrThrow({ where: { name: "Motors" } });
  const sedansSubCategory = await prisma.eavSubCategory.findUniqueOrThrow({
    where: { categoryId_name: { categoryId: motorsCategory.id, name: "Sedans" } },
  });
  const brandField = await prisma.customField.findUniqueOrThrow({ where: { name: "motors_brand" } });
  const yearField = await prisma.customField.findUniqueOrThrow({ where: { name: "motors_year" } });

  const totalListings = await prisma.eavListing.count();
  console.log(`Dataset size: ${totalListings.toLocaleString()} EAV listings`);
  console.log(`Each scenario: 1 warm-up + ${RUNS} timed runs (averaged)\n`);

  const results: BenchResult[] = [];

  // ------------------------------------------------------------------
  // 1. Subcategory filter
  // ------------------------------------------------------------------
  {
    const sql = `SELECT id FROM eav_listings WHERE "subCategoryId" = '${sedansSubCategory.id}'`;
    const indexesUsed = await explainIndexes(prisma, sql);
    results.push(
      await runBenchmark(
        `1. Subcategory filter ("${sedansSubCategory.name}")`,
        () => prisma.eavListing.findMany({ where: { subCategoryId: sedansSubCategory.id }, select: { id: true, title: true } }),
        indexesUsed
      )
    );
  }

  // ------------------------------------------------------------------
  // 2. EAV exact match — Prisma's to-many relation filter compiles to an
  //    EXISTS subquery that CAN use the (customFieldId, valueText) index —
  //    no #>> operator mismatch here, unlike JSONB.
  // ------------------------------------------------------------------
  {
    const sql = `SELECT id FROM eav_listings l WHERE l."categoryId" = '${motorsCategory.id}' AND EXISTS (SELECT 1 FROM listing_field_values lfv WHERE lfv."listingId" = l.id AND lfv."customFieldId" = '${brandField.id}' AND lfv."valueText" = '${BRAND}')`;
    const indexesUsed = await explainIndexes(prisma, sql);
    results.push(
      await runBenchmark(
        `2. EAV exact match (categoryId + brand="${BRAND}")`,
        () =>
          prisma.eavListing.findMany({
            where: { categoryId: motorsCategory.id, fieldValues: { some: { customFieldId: brandField.id, valueText: BRAND } } },
            select: { id: true, title: true },
          }),
        indexesUsed
      )
    );
  }

  // ------------------------------------------------------------------
  // 3. EAV range filter — (customFieldId, valueNumber) B-Tree supports
  //    ranges directly, unlike the JSONB jsonb_ops GIN index.
  // ------------------------------------------------------------------
  {
    const sql = `SELECT id FROM eav_listings l WHERE l."categoryId" = '${motorsCategory.id}' AND EXISTS (SELECT 1 FROM listing_field_values lfv WHERE lfv."listingId" = l.id AND lfv."customFieldId" = '${yearField.id}' AND lfv."valueNumber" >= ${MIN_YEAR})`;
    const indexesUsed = await explainIndexes(prisma, sql);
    results.push(
      await runBenchmark(
        `3. EAV range filter (categoryId + year>=${MIN_YEAR})`,
        () =>
          prisma.eavListing.findMany({
            where: { categoryId: motorsCategory.id, fieldValues: { some: { customFieldId: yearField.id, valueNumber: { gte: MIN_YEAR } } } },
            select: { id: true, title: true },
          }),
        indexesUsed
      )
    );
  }

  // ------------------------------------------------------------------
  // 4. Combined FTS + EAV, entirely via Prisma. Same query as row 6 below;
  //    kept as its own row (scenario 4 of the original 4, not a variant).
  // ------------------------------------------------------------------
  {
    const sql = `SELECT id FROM eav_listings l WHERE l."categoryId" = '${motorsCategory.id}' AND EXISTS (SELECT 1 FROM listing_field_values lfv WHERE lfv."listingId" = l.id AND lfv."customFieldId" = '${brandField.id}' AND lfv."valueText" = '${BRAND}') AND (to_tsvector(l.title) @@ to_tsquery('${FTS_TERM}') OR to_tsvector(l.description) @@ to_tsquery('${FTS_TERM}'))`;
    const indexesUsed = await explainIndexes(prisma, sql);
    results.push(
      await runBenchmark(
        `4. Combined FTS ("${FTS_TERM}") + EAV (brand="${BRAND}") + category`,
        () =>
          prisma.eavListing.findMany({
            where: {
              categoryId: motorsCategory.id,
              fieldValues: { some: { customFieldId: brandField.id, valueText: BRAND } },
              OR: [{ title: { search: FTS_TERM } }, { description: { search: FTS_TERM } }],
            },
            select: { id: true, title: true },
          }),
        indexesUsed
      )
    );
  }

  // ------------------------------------------------------------------
  // 5-7. The SAME complex search (category + brand + "Silver") run 3 ways.
  // ------------------------------------------------------------------

  // 5. Without FTS — ILIKE
  {
    const sql = `SELECT id FROM eav_listings l WHERE l."categoryId" = '${motorsCategory.id}' AND EXISTS (SELECT 1 FROM listing_field_values lfv WHERE lfv."listingId" = l.id AND lfv."customFieldId" = '${brandField.id}' AND lfv."valueText" = '${BRAND}') AND (l.title ILIKE '%${FTS_TERM}%' OR l.description ILIKE '%${FTS_TERM}%')`;
    const indexesUsed = await explainIndexes(prisma, sql);
    results.push(
      await runBenchmark(
        `5. Complex search — without FTS (ILIKE "${FTS_TERM}")`,
        () =>
          prisma.eavListing.findMany({
            where: {
              categoryId: motorsCategory.id,
              fieldValues: { some: { customFieldId: brandField.id, valueText: BRAND } },
              OR: [
                { title: { contains: FTS_TERM, mode: "insensitive" } },
                { description: { contains: FTS_TERM, mode: "insensitive" } },
              ],
            },
            select: { id: true, title: true },
          }),
        indexesUsed
      )
    );
  }

  // 6. With FTS — Prisma `search` filter (unindexed) — same query as row 4
  {
    const sql = `SELECT id FROM eav_listings l WHERE l."categoryId" = '${motorsCategory.id}' AND EXISTS (SELECT 1 FROM listing_field_values lfv WHERE lfv."listingId" = l.id AND lfv."customFieldId" = '${brandField.id}' AND lfv."valueText" = '${BRAND}') AND (to_tsvector(l.title) @@ to_tsquery('${FTS_TERM}') OR to_tsvector(l.description) @@ to_tsquery('${FTS_TERM}'))`;
    const indexesUsed = await explainIndexes(prisma, sql);
    results.push(
      await runBenchmark(
        `6. Complex search — with FTS (Prisma \`search\`, unindexed)`,
        () =>
          prisma.eavListing.findMany({
            where: {
              categoryId: motorsCategory.id,
              fieldValues: { some: { customFieldId: brandField.id, valueText: BRAND } },
              OR: [{ title: { search: FTS_TERM } }, { description: { search: FTS_TERM } }],
            },
            select: { id: true, title: true },
          }),
        indexesUsed
      )
    );
  }

  // 7. With FTS — raw SQL, indexed search_vector. EAV join needs no rewrite.
  {
    const sql = `SELECT id FROM eav_listings l WHERE l."categoryId" = '${motorsCategory.id}' AND EXISTS (SELECT 1 FROM listing_field_values lfv WHERE lfv."listingId" = l.id AND lfv."customFieldId" = '${brandField.id}' AND lfv."valueText" = '${BRAND}') AND l.search_vector @@ to_tsquery('english', '${FTS_TERM}')`;
    const indexesUsed = await explainIndexes(prisma, sql);
    results.push(
      await runBenchmark(
        `7. Complex search — with FTS (raw SQL, indexed)`,
        () =>
          prisma.$queryRawUnsafe(
            `SELECT l.id, l.title FROM eav_listings l WHERE l."categoryId" = $1 AND EXISTS (SELECT 1 FROM listing_field_values lfv WHERE lfv."listingId" = l.id AND lfv."customFieldId" = $2 AND lfv."valueText" = $3) AND l.search_vector @@ to_tsquery('english', $4)`,
            motorsCategory.id,
            brandField.id,
            BRAND,
            FTS_TERM
          ),
        indexesUsed
      )
    );
  }

  console.log("\n" + "#".repeat(90));
  console.log("EAV SEARCH ANALYSIS SUMMARY (7 scenarios)");
  console.log("#".repeat(90));
  printSummaryTable(results);

  console.log("\n" + "#".repeat(90));
  console.log("EXECUTION PLAN ANALYSIS (EXPLAIN ANALYZE) — rows 5, 6, 7");
  console.log("#".repeat(90));

  await printExplainAnalyze(
    prisma,
    "Row 5 — without FTS (ILIKE)",
    `SELECT l.id, l.title FROM eav_listings l
WHERE l."categoryId" = '${motorsCategory.id}'
  AND EXISTS (SELECT 1 FROM listing_field_values lfv WHERE lfv."listingId" = l.id AND lfv."customFieldId" = '${brandField.id}' AND lfv."valueText" = '${BRAND}')
  AND (l.title ILIKE '%${FTS_TERM}%' OR l.description ILIKE '%${FTS_TERM}%')`
  );

  await printExplainAnalyze(
    prisma,
    "Row 6 — with FTS, Prisma `search` filter (unindexed) — same plan shape as row 4",
    `SELECT l.id, l.title FROM eav_listings l
WHERE l."categoryId" = '${motorsCategory.id}'
  AND EXISTS (SELECT 1 FROM listing_field_values lfv WHERE lfv."listingId" = l.id AND lfv."customFieldId" = '${brandField.id}' AND lfv."valueText" = '${BRAND}')
  AND (to_tsvector(l.title) @@ to_tsquery('${FTS_TERM}') OR to_tsvector(l.description) @@ to_tsquery('${FTS_TERM}'))`
  );

  await printExplainAnalyze(
    prisma,
    "Row 7 — with FTS, raw SQL indexed",
    `SELECT l.id, l.title FROM eav_listings l
WHERE l."categoryId" = '${motorsCategory.id}'
  AND EXISTS (SELECT 1 FROM listing_field_values lfv WHERE lfv."listingId" = l.id AND lfv."customFieldId" = '${brandField.id}' AND lfv."valueText" = '${BRAND}')
  AND l.search_vector @@ to_tsquery('english', '${FTS_TERM}')`
  );

  console.log("\nDone.");
}

main()
  .catch((err) => {
    console.error("EAV search analysis failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
