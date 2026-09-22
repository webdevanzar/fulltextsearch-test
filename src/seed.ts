import { PrismaClient, Prisma } from "@prisma/client";
import { buildListingContent, CATEGORY_NAMES, CategoryName, TAXONOMY } from "./lib/listing-content";

const prisma = new PrismaClient();

const TOTAL_LISTINGS = 100_000;
const BATCH_SIZE = 2_000; // keeps (columns * batch) comfortably under Postgres' 65535 bind-param limit

async function seedTaxonomy(): Promise<Map<string, string>> {
  console.log("Seeding categories and subcategories...");

  // subCategoryKey -> subCategoryId, keyed as "CategoryName::SubCategoryName"
  const subCategoryIds = new Map<string, string>();

  for (const categoryName of CATEGORY_NAMES) {
    const category = await prisma.category.create({ data: { name: categoryName } });

    for (const subCategoryName of TAXONOMY[categoryName]) {
      const subCategory = await prisma.subCategory.create({
        data: { name: subCategoryName, categoryId: category.id },
      });
      subCategoryIds.set(`${categoryName}::${subCategoryName}`, subCategory.id);
    }
  }

  console.log(`Seeded ${CATEGORY_NAMES.length} categories, ${subCategoryIds.size} subcategories.`);
  return subCategoryIds;
}

async function main() {
  const existingListings = await prisma.listing.count();
  if (existingListings > 0) {
    console.log(`Table already has ${existingListings.toLocaleString()} listings. Truncating before reseeding...`);
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "listings" RESTART IDENTITY CASCADE;`);
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "sub_categories" RESTART IDENTITY CASCADE;`);
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "categories" RESTART IDENTITY CASCADE;`);
  }

  const subCategoryIds = await seedTaxonomy();

  console.log(`Seeding ${TOTAL_LISTINGS.toLocaleString()} listings in batches of ${BATCH_SIZE.toLocaleString()}...`);

  const start = Date.now();
  let inserted = 0;

  const categoryIdByName = new Map<CategoryName, string>();
  const categories = await prisma.category.findMany();
  for (const c of categories) categoryIdByName.set(c.name as CategoryName, c.id);

  for (let batchStart = 0; batchStart < TOTAL_LISTINGS; batchStart += BATCH_SIZE) {
    const batchCount = Math.min(BATCH_SIZE, TOTAL_LISTINGS - batchStart);
    const contents = Array.from({ length: batchCount }, () => buildListingContent());

    const data = contents.map((content) => ({
      title: content.title,
      description: content.description,
      price: new Prisma.Decimal(content.price),
      customData: content.attributes,
      categoryId: categoryIdByName.get(content.categoryName)!,
      subCategoryId: subCategoryIds.get(`${content.categoryName}::${content.subCategoryName}`)!,
    }));

    await prisma.listing.createMany({ data });

    inserted += batchCount;
    const pct = ((inserted / TOTAL_LISTINGS) * 100).toFixed(1);
    process.stdout.write(`\r  Inserted ${inserted.toLocaleString()} / ${TOTAL_LISTINGS.toLocaleString()} (${pct}%)`);
  }

  const elapsedSec = ((Date.now() - start) / 1000).toFixed(2);
  console.log(`\nDone. Seeded ${inserted.toLocaleString()} listings in ${elapsedSec}s.`);
}

main()
  .catch((err) => {
    console.error("Seeding failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
