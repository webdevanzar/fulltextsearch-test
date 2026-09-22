import { PrismaClient } from "@prisma/client";
import { BenchResult, explainIndexes, printExplainAnalyze, printSummaryTable, runBenchmark, RUNS } from "./lib/bench";

const prisma = new PrismaClient();

// ============================================================================
// One script, one table, 7 rows: the 4 individual/combined filter scenarios
// (subcategory / JSON exact / JSON range / combined FTS+JSON via Prisma)
// PLUS the 3 "same complex search, 3 implementations" variants (ILIKE /
// Prisma `search` unindexed / raw SQL indexed) — merged from what used to
// be two separate files (benchmark.ts + complex-search.ts).
// ============================================================================

const FTS_TERM = "Silver";
const JSON_BRAND = "Toyota";
const JSON_MIN_YEAR = 2020;

async function main() {
  const motorsCategory = await prisma.category.findUniqueOrThrow({ where: { name: "Motors" } });
  const sedansSubCategory = await prisma.subCategory.findUniqueOrThrow({
    where: { categoryId_name: { categoryId: motorsCategory.id, name: "Sedans" } },
  });

  const totalListings = await prisma.listing.count();
  console.log(`Dataset size: ${totalListings.toLocaleString()} listings`);
  console.log(`Each scenario: 1 warm-up + ${RUNS} timed runs (averaged)\n`);

  const results: BenchResult[] = [];

  // ------------------------------------------------------------------
  // 1. Subcategory filter
  // ------------------------------------------------------------------
  {
    const sql = `SELECT id FROM listings WHERE "subCategoryId" = '${sedansSubCategory.id}'`;
    const indexesUsed = await explainIndexes(prisma, sql);
    results.push(
      await runBenchmark(
        `1. Subcategory filter ("${sedansSubCategory.name}")`,
        () => prisma.listing.findMany({ where: { subCategoryId: sedansSubCategory.id }, select: { id: true, title: true } }),
        indexesUsed
      )
    );
  }

  // ------------------------------------------------------------------
  // 2. JSON exact match — Prisma's native JSON path filter. Its #>> shape
  //    cannot use the jsonb_ops GIN index (see migration.sql).
  // ------------------------------------------------------------------
  {
    const sql = `SELECT id FROM listings WHERE "categoryId" = '${motorsCategory.id}' AND "customData"#>>'{brand}' = '${JSON_BRAND}'`;
    const indexesUsed = await explainIndexes(prisma, sql);
    results.push(
      await runBenchmark(
        `2. JSON exact match (categoryId + brand="${JSON_BRAND}")`,
        () =>
          prisma.listing.findMany({
            where: { categoryId: motorsCategory.id, customData: { path: ["brand"], equals: JSON_BRAND } },
            select: { id: true, title: true },
          }),
        indexesUsed
      )
    );
  }

  // ------------------------------------------------------------------
  // 3. JSON range filter — jsonb_ops GIN can't do ranges even in principle.
  // ------------------------------------------------------------------
  {
    const sql = `SELECT id FROM listings WHERE "categoryId" = '${motorsCategory.id}' AND ("customData"#>>'{year}')::numeric >= ${JSON_MIN_YEAR}`;
    const indexesUsed = await explainIndexes(prisma, sql);
    results.push(
      await runBenchmark(
        `3. JSON range filter (categoryId + year>=${JSON_MIN_YEAR})`,
        () =>
          prisma.listing.findMany({
            where: { categoryId: motorsCategory.id, customData: { path: ["year"], gte: JSON_MIN_YEAR } },
            select: { id: true, title: true },
          }),
        indexesUsed
      )
    );
  }

  // ------------------------------------------------------------------
  // 4. Combined FTS + JSON, entirely via Prisma — categoryId + brand + FTS
  //    search all together. Same query shape as row 6 below; kept as its
  //    own row since it's "scenario 4" of the original 4, not a variant.
  // ------------------------------------------------------------------
  {
    const sql = `SELECT id FROM listings WHERE "categoryId" = '${motorsCategory.id}' AND "customData"#>>'{brand}' = '${JSON_BRAND}' AND (to_tsvector(title) @@ to_tsquery('${FTS_TERM}') OR to_tsvector(description) @@ to_tsquery('${FTS_TERM}'))`;
    const indexesUsed = await explainIndexes(prisma, sql);
    results.push(
      await runBenchmark(
        `4. Combined FTS ("${FTS_TERM}") + JSON (brand="${JSON_BRAND}") + category`,
        () =>
          prisma.listing.findMany({
            where: {
              categoryId: motorsCategory.id,
              customData: { path: ["brand"], equals: JSON_BRAND },
              OR: [{ title: { search: FTS_TERM } }, { description: { search: FTS_TERM } }],
            },
            select: { id: true, title: true },
          }),
        indexesUsed
      )
    );
  }

  // ------------------------------------------------------------------
  // 5-7. The SAME complex search (category + brand + "Silver") run 3 ways,
  // isolating what changes when you swap only the text-matching strategy.
  // ------------------------------------------------------------------

  // 5. Without FTS — ILIKE
  {
    const sql = `SELECT id FROM listings WHERE "categoryId" = '${motorsCategory.id}' AND "customData"#>>'{brand}' = '${JSON_BRAND}' AND (title ILIKE '%${FTS_TERM}%' OR description ILIKE '%${FTS_TERM}%')`;
    const indexesUsed = await explainIndexes(prisma, sql);
    results.push(
      await runBenchmark(
        `5. Complex search — without FTS (ILIKE "${FTS_TERM}")`,
        () =>
          prisma.listing.findMany({
            where: {
              categoryId: motorsCategory.id,
              customData: { path: ["brand"], equals: JSON_BRAND },
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
    const sql = `SELECT id FROM listings WHERE "categoryId" = '${motorsCategory.id}' AND "customData"#>>'{brand}' = '${JSON_BRAND}' AND (to_tsvector(title) @@ to_tsquery('${FTS_TERM}') OR to_tsvector(description) @@ to_tsquery('${FTS_TERM}'))`;
    const indexesUsed = await explainIndexes(prisma, sql);
    results.push(
      await runBenchmark(
        `6. Complex search — with FTS (Prisma \`search\`, unindexed)`,
        () =>
          prisma.listing.findMany({
            where: {
              categoryId: motorsCategory.id,
              customData: { path: ["brand"], equals: JSON_BRAND },
              OR: [{ title: { search: FTS_TERM } }, { description: { search: FTS_TERM } }],
            },
            select: { id: true, title: true },
          }),
        indexesUsed
      )
    );
  }

  // 7. With FTS — raw SQL, indexed search_vector + @> JSON containment
  {
    const sql = `SELECT id FROM listings WHERE "categoryId" = '${motorsCategory.id}' AND "customData" @> '{"brand":"${JSON_BRAND}"}'::jsonb AND search_vector @@ to_tsquery('english', '${FTS_TERM}')`;
    const indexesUsed = await explainIndexes(prisma, sql);
    results.push(
      await runBenchmark(
        `7. Complex search — with FTS (raw SQL, indexed)`,
        () =>
          prisma.$queryRawUnsafe(
            `SELECT id, title FROM listings WHERE "categoryId" = $1 AND "customData" @> $2::jsonb AND search_vector @@ to_tsquery('english', $3)`,
            motorsCategory.id,
            JSON.stringify({ brand: JSON_BRAND }),
            FTS_TERM
          ),
        indexesUsed
      )
    );
  }

  console.log("\n" + "#".repeat(90));
  console.log("SEARCH ANALYSIS SUMMARY (7 scenarios)");
  console.log("#".repeat(90));
  printSummaryTable(results);

  console.log("\n" + "#".repeat(90));
  console.log("EXECUTION PLAN ANALYSIS (EXPLAIN ANALYZE) — rows 5, 6, 7");
  console.log("#".repeat(90));

  await printExplainAnalyze(
    prisma,
    "Row 5 — without FTS (ILIKE)",
    `SELECT id, title FROM listings
WHERE "categoryId" = '${motorsCategory.id}'
  AND "customData"#>>'{brand}' = '${JSON_BRAND}'
  AND (title ILIKE '%${FTS_TERM}%' OR description ILIKE '%${FTS_TERM}%')`
  );

  await printExplainAnalyze(
    prisma,
    "Row 6 — with FTS, Prisma `search` filter (unindexed) — same plan shape as row 4",
    `SELECT id, title FROM listings
WHERE "categoryId" = '${motorsCategory.id}'
  AND "customData"#>>'{brand}' = '${JSON_BRAND}'
  AND (to_tsvector(title) @@ to_tsquery('${FTS_TERM}') OR to_tsvector(description) @@ to_tsquery('${FTS_TERM}'))`
  );

  await printExplainAnalyze(
    prisma,
    "Row 7 — with FTS, raw SQL indexed",
    `SELECT id, title FROM listings
WHERE "categoryId" = '${motorsCategory.id}'
  AND "customData" @> '{"brand":"${JSON_BRAND}"}'::jsonb
  AND search_vector @@ to_tsquery('english', '${FTS_TERM}')`
  );

  console.log("\nDone.");
}

main()
  .catch((err) => {
    console.error("Search analysis failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
