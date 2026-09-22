import { PrismaClient, Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import { buildListingContent, CATEGORY_FIELDS, CATEGORY_NAMES, CategoryName, TAXONOMY } from "./lib/listing-content";

const prisma = new PrismaClient();

const TOTAL_LISTINGS = 100_000;
const BATCH_SIZE = 2_000; // keeps (columns * batch) comfortably under Postgres' 65535 bind-param limit

async function seedCustomFields(): Promise<Map<string, string>> {
  console.log("Seeding custom fields...");
  const customFieldIds = new Map<string, string>(); // system name -> id

  for (const categoryName of CATEGORY_NAMES) {
    for (const field of CATEGORY_FIELDS[categoryName]) {
      if (customFieldIds.has(field.name)) continue; // system keys are already category-scoped, but guard anyway
      const created = await prisma.customField.create({
        data: {
          name: field.name,
          label: field.label,
          type: field.type,
          options: field.options ?? undefined,
        },
      });
      customFieldIds.set(field.name, created.id);
    }
  }

  console.log(`Seeded ${customFieldIds.size} custom fields.`);
  return customFieldIds;
}

async function seedTaxonomy(customFieldIds: Map<string, string>): Promise<Map<string, string>> {
  console.log("Seeding EAV categories and subcategories...");
  const subCategoryIds = new Map<string, string>(); // "CategoryName::SubCategoryName" -> id

  for (const categoryName of CATEGORY_NAMES) {
    const category = await prisma.eavCategory.create({ data: { name: categoryName } });
    const fieldsForCategory = CATEGORY_FIELDS[categoryName];

    for (const subCategoryName of TAXONOMY[categoryName]) {
      const subCategory = await prisma.eavSubCategory.create({
        data: { name: subCategoryName, categoryId: category.id },
      });
      subCategoryIds.set(`${categoryName}::${subCategoryName}`, subCategory.id);

      await prisma.subCategoryField.createMany({
        data: fieldsForCategory.map((f) => ({
          subCategoryId: subCategory.id,
          customFieldId: customFieldIds.get(f.name)!,
        })),
      });
    }
  }

  console.log(`Seeded ${CATEGORY_NAMES.length} categories, ${subCategoryIds.size} subcategories.`);
  return subCategoryIds;
}

interface FieldValueRow {
  id: string;
  listingId: string;
  customFieldId: string;
  valueText?: string;
  valueNumber?: Prisma.Decimal;
  valueBoolean?: boolean;
}

async function main() {
  const existingListings = await prisma.eavListing.count();
  if (existingListings > 0) {
    console.log(`Table already has ${existingListings.toLocaleString()} EAV listings. Truncating before reseeding...`);
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "listing_field_values" RESTART IDENTITY CASCADE;`);
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "sub_category_fields" RESTART IDENTITY CASCADE;`);
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "custom_fields" RESTART IDENTITY CASCADE;`);
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "eav_listings" RESTART IDENTITY CASCADE;`);
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "eav_sub_categories" RESTART IDENTITY CASCADE;`);
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "eav_categories" RESTART IDENTITY CASCADE;`);
  }

  const customFieldIds = await seedCustomFields();
  const subCategoryIds = await seedTaxonomy(customFieldIds);

  console.log(`Seeding ${TOTAL_LISTINGS.toLocaleString()} EAV listings in batches of ${BATCH_SIZE.toLocaleString()}...`);

  const start = Date.now();
  let inserted = 0;
  let fieldValuesInserted = 0;

  const categoryIdByName = new Map<CategoryName, string>();
  const categories = await prisma.eavCategory.findMany();
  for (const c of categories) categoryIdByName.set(c.name as CategoryName, c.id);

  for (let batchStart = 0; batchStart < TOTAL_LISTINGS; batchStart += BATCH_SIZE) {
    const batchCount = Math.min(BATCH_SIZE, TOTAL_LISTINGS - batchStart);
    const contents = Array.from({ length: batchCount }, () => buildListingContent());

    // Generate the id client-side (overriding @default(uuid())) so field-value
    // rows below can reference it without a round trip back to the DB.
    const listingIds = contents.map(() => randomUUID());

    const listingRows = contents.map((content, i) => ({
      id: listingIds[i],
      title: content.title,
      description: content.description,
      price: new Prisma.Decimal(content.price),
      categoryId: categoryIdByName.get(content.categoryName)!,
      subCategoryId: subCategoryIds.get(`${content.categoryName}::${content.subCategoryName}`)!,
    }));

    await prisma.eavListing.createMany({ data: listingRows });

    const fieldValueRows: FieldValueRow[] = [];
    contents.forEach((content, i) => {
      for (const field of CATEGORY_FIELDS[content.categoryName]) {
        const rawValue = content.attributes[field.key];
        const row: FieldValueRow = {
          id: randomUUID(),
          listingId: listingIds[i],
          customFieldId: customFieldIds.get(field.name)!,
        };
        if (field.type === "NUMBER") row.valueNumber = new Prisma.Decimal(rawValue as number);
        else if (field.type === "BOOLEAN") row.valueBoolean = rawValue as boolean;
        else row.valueText = String(rawValue);
        fieldValueRows.push(row);
      }
    });

    await prisma.listingFieldValue.createMany({ data: fieldValueRows });

    inserted += batchCount;
    fieldValuesInserted += fieldValueRows.length;
    const pct = ((inserted / TOTAL_LISTINGS) * 100).toFixed(1);
    process.stdout.write(
      `\r  Inserted ${inserted.toLocaleString()} / ${TOTAL_LISTINGS.toLocaleString()} listings (${pct}%), ${fieldValuesInserted.toLocaleString()} field values`
    );
  }

  const elapsedSec = ((Date.now() - start) / 1000).toFixed(2);
  console.log(`\nDone. Seeded ${inserted.toLocaleString()} EAV listings + ${fieldValuesInserted.toLocaleString()} field values in ${elapsedSec}s.`);
}

main()
  .catch((err) => {
    console.error("EAV seeding failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
