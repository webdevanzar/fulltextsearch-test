import { faker } from "@faker-js/faker";

// Shared between src/seed.ts (JSONB customData) and src/eav-seed.ts (EAV
// ListingFieldValue rows) so the two storage strategies get *statistically
// equivalent* data — same brand/color distributions, same "Toyota"/"Silver"
// weighting — making a timing comparison between them meaningful.

export const TAXONOMY = {
  Motors: ["Sedans", "SUVs", "Motorcycles"],
  "Real Estate": ["Apartments", "Houses", "Commercial"],
  Gadgets: ["Smartphones", "Laptops", "Wearables"],
  Furniture: ["Living Room", "Bedroom", "Office"],
  Fashion: ["Men's", "Women's", "Kids'"],
} as const;

export type CategoryName = keyof typeof TAXONOMY;
export const CATEGORY_NAMES = Object.keys(TAXONOMY) as CategoryName[];

export type FieldType = "TEXT" | "NUMBER" | "BOOLEAN" | "SELECT";

export interface FieldDef {
  /** attribute key as produced by buildListingContent()'s `attributes` object, e.g. "brand" */
  key: string;
  /** globally-unique CustomField system key, e.g. "motors_brand" (avoids the "brand" collision between Motors/Gadgets) */
  name: string;
  label: string;
  type: FieldType;
  options?: string[];
}

// Deliberately chosen so the benchmark's Motors/Toyota/Silver scenarios
// return meaningful, non-trivial result sets.
const MOTORS_BRANDS = ["Toyota", "Honda", "Ford", "BMW", "Mercedes-Benz", "Nissan", "Hyundai", "Volkswagen"];
const MOTORS_COLORS = ["Silver", "Black", "White", "Red", "Blue", "Gray"];

const GADGET_BRANDS = ["Apple", "Samsung", "Google", "Dell", "Lenovo", "Sony", "Microsoft"];
const GADGET_RAM = ["4GB", "8GB", "16GB", "32GB", "64GB"];
const GADGET_STORAGE = ["128GB", "256GB", "512GB", "1TB", "2TB"];

const FURNITURE_MATERIALS = ["Oak", "Walnut", "Velvet", "Leather", "Rattan", "Teak", "Marble", "Linen"];
const FURNITURE_COLORS = ["Brown", "Black", "Beige", "Gray", "White", "Navy"];

const FASHION_SIZES = ["XS", "S", "M", "L", "XL", "XXL"];
const FASHION_COLORS = ["Black", "White", "Navy", "Olive", "Burgundy", "Charcoal"];
const FASHION_MATERIALS = ["Cotton", "Denim", "Wool", "Polyester", "Linen", "Leather"];

export const CATEGORY_FIELDS: Record<CategoryName, FieldDef[]> = {
  Motors: [
    { key: "brand", name: "motors_brand", label: "Brand", type: "SELECT", options: MOTORS_BRANDS },
    { key: "year", name: "motors_year", label: "Year", type: "NUMBER" },
    { key: "mileage", name: "motors_mileage", label: "Mileage", type: "NUMBER" },
  ],
  "Real Estate": [
    { key: "bedrooms", name: "realestate_bedrooms", label: "Bedrooms", type: "NUMBER" },
    { key: "bathrooms", name: "realestate_bathrooms", label: "Bathrooms", type: "NUMBER" },
    { key: "sqft", name: "realestate_sqft", label: "Square Footage", type: "NUMBER" },
    { key: "furnished", name: "realestate_furnished", label: "Furnished", type: "BOOLEAN" },
  ],
  Gadgets: [
    { key: "brand", name: "gadgets_brand", label: "Brand", type: "SELECT", options: GADGET_BRANDS },
    { key: "ram", name: "gadgets_ram", label: "RAM", type: "SELECT", options: GADGET_RAM },
    { key: "storage", name: "gadgets_storage", label: "Storage", type: "SELECT", options: GADGET_STORAGE },
  ],
  Furniture: [
    { key: "material", name: "furniture_material", label: "Material", type: "SELECT", options: FURNITURE_MATERIALS },
    { key: "color", name: "furniture_color", label: "Color", type: "SELECT", options: FURNITURE_COLORS },
    { key: "assemblyRequired", name: "furniture_assemblyRequired", label: "Assembly Required", type: "BOOLEAN" },
  ],
  Fashion: [
    { key: "size", name: "fashion_size", label: "Size", type: "SELECT", options: FASHION_SIZES },
    { key: "color", name: "fashion_color", label: "Color", type: "SELECT", options: FASHION_COLORS },
    { key: "material", name: "fashion_material", label: "Material", type: "SELECT", options: FASHION_MATERIALS },
  ],
};

export interface ListingContent {
  title: string;
  description: string;
  price: string; // decimal string, e.g. "1234.56"
  categoryName: CategoryName;
  subCategoryName: string;
  attributes: Record<string, string | number | boolean>;
}

function randomFrom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function buildMotors(subCategoryName: string): ListingContent {
  const brand = randomFrom(MOTORS_BRANDS);
  const color = randomFrom(MOTORS_COLORS);
  const year = randomInt(2005, 2025);
  const mileage = randomInt(500, 180_000);
  const model = faker.vehicle.model();

  const title = `${year} ${brand} ${model} - ${color}`;
  const description = [
    `This ${color.toLowerCase()} ${year} ${brand} ${model} is in excellent condition with ${mileage.toLocaleString()} miles on the odometer.`,
    faker.lorem.paragraph({ min: 3, max: 6 }),
    `VIN reference ${faker.vehicle.vin()}. Full service history available, ${faker.vehicle.fuel().toLowerCase()} engine, ${faker.vehicle.type().toLowerCase()} body style.`,
    faker.lorem.paragraph({ min: 2, max: 4 }),
  ].join(" ");

  return {
    title,
    description,
    price: faker.commerce.price({ min: 1500, max: 85000, dec: 2 }),
    categoryName: "Motors",
    subCategoryName,
    attributes: { brand, year, mileage },
  };
}

function buildRealEstate(subCategoryName: string): ListingContent {
  const bedrooms = randomInt(1, 6);
  const bathrooms = randomInt(1, 4);
  const sqft = randomInt(400, 5000);
  const furnished = Math.random() < 0.4;
  const city = faker.location.city();

  const title = `${bedrooms} Bed ${subCategoryName.replace(/s$/, "")} in ${city}`;
  const description = [
    `Spacious ${bedrooms}-bedroom, ${bathrooms}-bathroom property spanning ${sqft.toLocaleString()} sqft in the heart of ${city}.`,
    faker.lorem.paragraph({ min: 3, max: 6 }),
    furnished ? "Comes fully furnished and ready to move in." : "Unfurnished, offering a blank canvas to make it your own.",
    faker.lorem.paragraph({ min: 2, max: 4 }),
  ].join(" ");

  return {
    title,
    description,
    price: faker.commerce.price({ min: 800, max: 2_500_000, dec: 2 }),
    categoryName: "Real Estate",
    subCategoryName,
    attributes: { bedrooms, bathrooms, sqft, furnished },
  };
}

function buildGadgets(subCategoryName: string): ListingContent {
  const brand = randomFrom(GADGET_BRANDS);
  const ram = randomFrom(GADGET_RAM);
  const storage = randomFrom(GADGET_STORAGE);

  const title = `${brand} ${subCategoryName.replace(/s$/, "")} ${ram}/${storage}`;
  const description = [
    faker.commerce.productDescription(),
    faker.lorem.paragraph({ min: 3, max: 6 }),
    `Configured with ${ram} RAM and ${storage} of storage, this ${brand} device is built for everyday performance and reliability.`,
    faker.lorem.paragraph({ min: 2, max: 4 }),
  ].join(" ");

  return {
    title,
    description,
    price: faker.commerce.price({ min: 49, max: 3500, dec: 2 }),
    categoryName: "Gadgets",
    subCategoryName,
    attributes: { brand, ram, storage },
  };
}

function buildFurniture(subCategoryName: string): ListingContent {
  const material = randomFrom(FURNITURE_MATERIALS);
  const color = randomFrom(FURNITURE_COLORS);
  const assemblyRequired = Math.random() < 0.5;
  const adjective = faker.commerce.productAdjective();

  const title = `${adjective} ${color} ${material} ${subCategoryName} Set`;
  const description = [
    faker.commerce.productDescription(),
    faker.lorem.paragraph({ min: 3, max: 6 }),
    `Crafted from premium ${material.toLowerCase()}, finished in ${color.toLowerCase()}. ${assemblyRequired ? "Some assembly required." : "Arrives fully assembled."}`,
    faker.lorem.paragraph({ min: 2, max: 4 }),
  ].join(" ");

  return {
    title,
    description,
    price: faker.commerce.price({ min: 50, max: 6000, dec: 2 }),
    categoryName: "Furniture",
    subCategoryName,
    attributes: { material, color, assemblyRequired },
  };
}

function buildFashion(subCategoryName: string): ListingContent {
  const size = randomFrom(FASHION_SIZES);
  const color = randomFrom(FASHION_COLORS);
  const material = randomFrom(FASHION_MATERIALS);
  const adjective = faker.commerce.productAdjective();

  const title = `${adjective} ${color} ${material} ${faker.commerce.product()}`;
  const description = [
    faker.commerce.productDescription(),
    faker.lorem.paragraph({ min: 2, max: 5 }),
    `Available in size ${size}, made from ${material.toLowerCase()} in a ${color.toLowerCase()} colorway.`,
  ].join(" ");

  return {
    title,
    description,
    price: faker.commerce.price({ min: 10, max: 400, dec: 2 }),
    categoryName: "Fashion",
    subCategoryName,
    attributes: { size, color, material },
  };
}

export function buildListingContent(): ListingContent {
  const categoryName = randomFrom(CATEGORY_NAMES);
  const subCategoryName = randomFrom(TAXONOMY[categoryName]);

  switch (categoryName) {
    case "Motors":
      return buildMotors(subCategoryName);
    case "Real Estate":
      return buildRealEstate(subCategoryName);
    case "Gadgets":
      return buildGadgets(subCategoryName);
    case "Furniture":
      return buildFurniture(subCategoryName);
    case "Fashion":
      return buildFashion(subCategoryName);
  }
}
