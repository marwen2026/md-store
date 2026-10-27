require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const PDFDocument = require("pdfkit");
const { colorName, normalizeColorHex } = require("./public/color-names");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_ME_NOW";
if (process.env.NODE_ENV === "production" && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
  throw new Error("JWT_SECRET must contain at least 32 characters in production");
}
const WA = String(process.env.WHATSAPP || "").replace(/\D/g, "");
const WHATSAPP_CONFIGURED = WA.length >= 10 && WA.length <= 15 && WA !== "21600000000";
const STORE = process.env.STORE_NAME || "M&D Store";
const CURRENCY = process.env.CURRENCY || "TND";
const PAYMENT_METHOD = "cash_on_delivery";
const MAX_MONEY = 9999999999.99;
const FREE_SHIPPING_THRESHOLD = 199;
const LOW_STOCK_THRESHOLD = 5;
const DEFAULT_CAMPAIGN_IMAGE_COUNT = 4;
const MAX_CAMPAIGN_IMAGE_COUNT = 20;
const MAX_CUSTOM_CAMPAIGN_IMAGE_COUNT = MAX_CAMPAIGN_IMAGE_COUNT - DEFAULT_CAMPAIGN_IMAGE_COUNT;
const HERO_DRAFT_SETTINGS = [
  "hero_background_url",
  "hero_logo_url",
  "hero_card_x",
  "hero_card_y",
  "hero_overlay",
  "hero_price_size",
  "product_columns",
  "category_columns",
  "mobile_logo_url"
];
const DEFAULT_NAVIGATION_LINKS = [
  { label_ar: "الرئيسية", label_fr: "Accueil", href: "#" },
  { label_ar: "جديدنا", label_fr: "Nouveautés", href: "#products" },
  { label_ar: "إكسسوارات", label_fr: "Accessoires", href: "#products" },
  { label_ar: "العروض الخاصة", label_fr: "Offres spéciales", href: "#offers" },
  { label_ar: "اتصل بنا", label_fr: "Contactez-nous", href: "#footer" }
];
const DEFAULT_CATEGORY_ICON_OPTIONS = [
  { id: "tag", label_ar: "عام", label_fr: "Générique", icon_type: "tag" },
  { id: "clothing", label_ar: "ملابس", label_fr: "Vêtements", icon_type: "clothing" },
  { id: "bag", label_ar: "حقائب", label_fr: "Sacs", icon_type: "bag" },
  { id: "watch", label_ar: "ساعات", label_fr: "Montres", icon_type: "watch" },
  { id: "accessory", label_ar: "إكسسوارات", label_fr: "Accessoires", icon_type: "accessory" }
];
const CATEGORY_ICON_TYPES = new Set(DEFAULT_CATEGORY_ICON_OPTIONS.map(option => option.icon_type));
const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const pool = new Pool({
  ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}),
  ...(process.env.PGSSL === "true" ? { ssl: { rejectUnauthorized: false } } : {})
});
const adminEventClients = new Set();
pool.on("error", error => console.error("Unexpected PostgreSQL pool error:", error));

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) req.body = {};
  next();
});
app.get("/", async (req, res) => {
  let title = "M-D Store";
  let description = "اكتشفوا تشكيلة M&D Store وتسوقوا بسهولة عبر موقعنا الإلكتروني.";
  const fallbackImage = "/social-preview.jpg";
  let image = fallbackImage;
  let productId = null;
  const requestedProductId = String(req.query.product || "");
  if (/^[1-9]\d*$/.test(requestedProductId) && Number.isSafeInteger(Number(requestedProductId))) {
    const result = await pool.query(
      `SELECT p.id, p.name, p.description,
         (SELECT path FROM product_images WHERE product_id = p.id ORDER BY id LIMIT 1) AS image
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN categories parent ON parent.id = c.parent_id
       WHERE p.id = $1 AND p.active = TRUE
         AND (p.category_id IS NULL OR (c.active = TRUE AND (c.parent_id IS NULL OR parent.active = TRUE)))`,
      [Number(requestedProductId)]
    );
    if (result.rowCount) {
      const product = result.rows[0];
      productId = product.id;
      title = `${product.name} — M&D Store`;
      description = product.description || `اكتشفوا ${product.name} وتسوقوه الآن من M&D Store.`;
      if (typeof product.image === "string" && /^\/uploads\/[A-Za-z0-9._-]+$/.test(product.image)) {
        try {
          await fs.promises.access(path.join(uploadDir, path.basename(product.image)));
          image = product.image;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      } else if (typeof product.image === "string" && /^\/api\/product-images\/[1-9]\d*$/.test(product.image)) {
        image = product.image;
      }
    }
  }
  const forwardedProtocol = req.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProtocol === "https" ? "https" : req.protocol;
  const publicUrl = String(process.env.PUBLIC_URL || `${protocol}://${req.get("host")}`).replace(/\/+$/, "");
  const pageUrl = new URL("/", `${publicUrl}/`);
  if (productId !== null) pageUrl.searchParams.set("product", String(productId));
  const imageUrl = new URL(image, `${publicUrl}/`).href;
  const escapeAttribute = value => String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
  const metadata = [
    `<meta name="description" content="${escapeAttribute(description)}">`,
    `<meta property="og:type" content="${productId === null ? "website" : "product"}">`,
    `<meta property="og:title" content="${escapeAttribute(title)}">`,
    `<meta property="og:description" content="${escapeAttribute(description)}">`,
    `<meta property="og:url" content="${escapeAttribute(pageUrl.href)}">`,
    `<meta property="og:image" content="${escapeAttribute(imageUrl)}">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${escapeAttribute(title)}">`,
    `<meta name="twitter:description" content="${escapeAttribute(description)}">`,
    `<meta name="twitter:image" content="${escapeAttribute(imageUrl)}">`
  ].join("\n");
  const html = await fs.promises.readFile(path.join(__dirname, "public/index.html"), "utf8");
  res.type("html").send(html.replace("<!-- SOCIAL_METADATA -->", metadata));
});
app.use("/uploads", express.static(uploadDir));
app.get("/uploads/:filename", (req, res) => {
  res.status(404).json({ error: "Image not found" });
});
app.get("/api/product-images/:id", async (req, res) => {
  if (!/^[1-9]\d*$/.test(req.params.id)) return res.status(404).json({ error: "Image not found" });
  const { rows } = await pool.query(
    "SELECT image_data, content_type FROM product_images WHERE id = $1",
    [Number(req.params.id)]
  );
  const image = rows[0];
  if (!image?.image_data || !image.content_type) return res.status(404).json({ error: "Image not found" });
  res.set({
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff"
  }).type(image.content_type).send(image.image_data);
});
app.use(express.static(path.join(__dirname, "public")));
app.use((req, res, next) => {
  res.on("finish", () => {
    const method = req.method.toUpperCase();
    if (!req.admin || !req.path.startsWith("/api/") ||
      !["POST", "PUT", "PATCH", "DELETE"].includes(method) ||
      res.statusCode < 200 || res.statusCode >= 300) return;
    pool.query(
      `INSERT INTO admin_audit_logs(admin_id, admin_username, method, endpoint)
       VALUES($1, $2, $3, $4)`,
      [req.admin.id, req.admin.username, method, req.path]
    ).catch(error => console.error("Could not record admin action:", error));
  });
  next();
});

function getToken(req) {
  const header = req.headers.authorization || "";
  if (/^Bearer /i.test(header)) return header.replace(/^Bearer /i, "");
  return typeof req.query.token === "string" ? req.query.token : "";
}

function auth(req, res, next) {
  try {
    req.admin = jwt.verify(getToken(req), JWT_SECRET);
    next();
  } catch (error) {
    res.status(401).json({ error: "غير مصرح" });
  }
}

function role(...roles) {
  return (req, res, next) => roles.includes(req.admin.role)
    ? next()
    : res.status(403).json({ error: "صلاحية غير كافية" });
}

function safeNum(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseProductInput(body) {
  const name = String(body.name || "").trim();
  const price = safeNum(body.price, NaN);
  const costPrice = body.cost_price === "" || body.cost_price == null ? null : safeNum(body.cost_price, NaN);
  const deliveryPrice = body.delivery_price === "" || body.delivery_price == null ? 0 : safeNum(body.delivery_price, NaN);
  const oldPrice = body.old_price === "" || body.old_price == null ? null : safeNum(body.old_price, NaN);
  const stock = safeNum(body.stock, 0);
  const categoryValue = String(body.category_id || "").trim();
  const categoryId = categoryValue ? Number(categoryValue) : null;
  const colorInput = String(body.colors || "").trim();
  const colors = colorInput ? colorInput.split(",").map(color => color.trim().toUpperCase()) : [];
    if (!name || !Number.isFinite(price) || price < 0 || price > MAX_MONEY ||
      (costPrice !== null && (!Number.isFinite(costPrice) || costPrice < 0 || costPrice > MAX_MONEY)) ||
      !Number.isFinite(deliveryPrice) || deliveryPrice < 0 || deliveryPrice > MAX_MONEY ||
      (oldPrice !== null && (!Number.isFinite(oldPrice) || oldPrice < 0 || oldPrice > MAX_MONEY)) ||
      !Number.isInteger(stock) || stock < 0 || stock > 2147483647 ||
      (categoryId !== null && (!Number.isInteger(categoryId) || categoryId < 1 || categoryId > 2147483647)) ||
      colors.length > 12 ||
      colors.some(color => !/^#[0-9A-F]{6}$/.test(color)) ||
      new Set(colors).size !== colors.length) {
    return null;
  }
  return {
    name,
    description: String(body.description || ""),
    categoryId,
    price,
    costPrice,
    deliveryPrice,
    oldPrice,
    stock,
    colors,
    advertised: ["1", "true", "on"].includes(String(body.advertised).toLowerCase()),
    active: body.active === undefined || ["1", "true", "on"].includes(String(body.active).toLowerCase())
  };
}

class OrderValidationError extends Error {}
class InventoryAvailabilityError extends Error {}

async function insertProductImages(client, productId, files = []) {
  for (const file of files) {
    const result = await client.query(
      `INSERT INTO product_images(product_id, path, image_data, content_type)
       VALUES($1, '', $2, $3) RETURNING id`,
      [productId, file.buffer, file.mimetype]
    );
    const imagePath = `/api/product-images/${result.rows[0].id}`;
    await client.query("UPDATE product_images SET path = $1 WHERE id = $2", [imagePath, result.rows[0].id]);
  }
}

async function migrateLegacyProductImages() {
  const { rows } = await pool.query(
    `SELECT id, path FROM product_images
     WHERE image_data IS NULL AND path ~ '^/uploads/[A-Za-z0-9._-]+$'`
  );
  const contentTypes = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif"
  };
  let migrated = 0;
  let missing = 0;
  for (const image of rows) {
    const filename = path.basename(image.path);
    let imageData;
    try {
      imageData = await fs.promises.readFile(path.join(uploadDir, filename));
    } catch (error) {
      if (error.code === "ENOENT") {
        missing++;
        continue;
      }
      throw error;
    }
    const contentType = contentTypes[path.extname(filename).toLowerCase()];
    if (!contentType) {
      throw new Error(`Unsupported legacy product image format: ${filename}`);
    }
    await pool.query(
      "UPDATE product_images SET path = $1, image_data = $2, content_type = $3 WHERE id = $4",
      [`/api/product-images/${image.id}`, imageData, contentType, image.id]
    );
    migrated++;
  }
  if (migrated) console.log(`Migrated ${migrated} product image(s) into PostgreSQL.`);
  if (missing) console.warn(`${missing} legacy product image(s) are missing from disk and must be uploaded again.`);
}

async function migrateLegacyHeroBackground() {
  const { rows } = await pool.query(
    "SELECT value FROM store_settings WHERE key = 'hero_background_url'"
  );
  const imagePath = rows[0]?.value || "";
  const useBundledBackground = async () => {
    await pool.query(
      "UPDATE store_settings SET value = '/hero-background.png' WHERE key = 'hero_background_url' AND value = $1",
      [imagePath]
    );
    console.warn("The saved hero background is unavailable; using the bundled background image.");
  };

  if (imagePath === "/api/store-assets/hero-background") {
    const { rows: assets } = await pool.query(
      "SELECT 1 FROM store_assets WHERE asset_key = 'hero_background'"
    );
    if (assets.length) return;
    await useBundledBackground();
    return;
  }
  if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(imagePath)) return;

  const filename = path.basename(imagePath);
  const contentTypes = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif"
  };
  const contentType = contentTypes[path.extname(filename).toLowerCase()];
  if (!contentType) {
    await useBundledBackground();
    return;
  }

  let imageData;
  try {
    imageData = await fs.promises.readFile(path.join(uploadDir, filename));
  } catch (error) {
    if (error.code === "ENOENT") {
      await useBundledBackground();
      return;
    }
    throw error;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO store_assets(asset_key, image_data, content_type)
       VALUES('hero_background', $1, $2)
       ON CONFLICT (asset_key) DO NOTHING`,
      [imageData, contentType]
    );
    await client.query(
      "UPDATE store_settings SET value = '/api/store-assets/hero-background' WHERE key = 'hero_background_url' AND value = $1",
      [imagePath]
    );
    await client.query("COMMIT");
    console.log("Migrated the legacy hero background into PostgreSQL.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function productRows(includeInactive = false) {
  const salesJoin = includeInactive ? "" : `
     LEFT JOIN (
       SELECT sold.product_id, sold.units_sold,
         ROW_NUMBER() OVER (ORDER BY sold.units_sold DESC, sold.product_id DESC) AS sales_rank
       FROM (
         SELECT oi.product_id, SUM(oi.quantity)::bigint AS units_sold
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE oi.product_id IS NOT NULL
           AND o.status NOT IN ('cancelled', 'returned')
           AND o.inventory_deducted = TRUE
         GROUP BY oi.product_id
       ) sold
     ) sales ON sales.product_id = p.id`;
  const products = await pool.query(
    `SELECT p.*, c.name AS category_name
       ${includeInactive ? "" : ", COALESCE(sales.units_sold, 0)::bigint AS units_sold, COALESCE(sales.sales_rank <= 3, FALSE) AS best_seller"}
     FROM products p LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN categories parent ON parent.id = c.parent_id
     ${salesJoin}
     ${includeInactive ? "" : "WHERE p.active = TRUE AND (p.category_id IS NULL OR (c.active = TRUE AND (c.parent_id IS NULL OR parent.active = TRUE)))"}
     ORDER BY CASE WHEN EXISTS (SELECT 1 FROM products ordered WHERE ordered.sort_order IS NOT NULL)
       THEN p.sort_order END ASC NULLS LAST,
       ${includeInactive ? "p.id DESC" : "COALESCE(sales.units_sold, 0) DESC, p.id DESC"}`
  );
  const images = await pool.query("SELECT id, product_id, path FROM product_images ORDER BY id");
  const imagesByProduct = new Map();
  for (const image of images.rows) {
    if (!imagesByProduct.has(image.product_id)) imagesByProduct.set(image.product_id, []);
    imagesByProduct.get(image.product_id).push({ id: image.id, path: image.path });
  }
  return products.rows.map(product => {
    const { cost_price, ...publicProduct } = product;
    return {
      ...(includeInactive ? product : publicProduct),
      images: imagesByProduct.get(product.id) || []
    };
  });
}

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    callback(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${extension}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) {
      const error = new Error("Seuls les fichiers JPEG, PNG, WebP et GIF sont acceptés");
      error.status = 400;
      return callback(error);
    }
    callback(null, true);
  }
});
const heroBackgroundUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) {
      const error = new Error("Seuls les fichiers JPEG, PNG, WebP et GIF sont acceptés");
      error.status = 400;
      return callback(error);
    }
    callback(null, true);
  }
});
const campaignImagesUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: MAX_CUSTOM_CAMPAIGN_IMAGE_COUNT },
  fileFilter: (req, file, callback) => {
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) {
      const error = new Error("Seuls les fichiers JPEG, PNG, WebP et GIF sont acceptés");
      error.status = 400;
      return callback(error);
    }
    callback(null, true);
  }
});
const productUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) {
      const error = new Error("Seuls les fichiers JPEG, PNG, WebP et GIF sont acceptés");
      error.status = 400;
      return callback(error);
    }
    callback(null, true);
  }
});

app.post("/api/login", async (req, res) => {
  const result = await pool.query("SELECT * FROM admins WHERE username = $1", [String(req.body.username || "")]);
  const admin = result.rows[0];
  if (!admin || !bcrypt.compareSync(String(req.body.password || ""), admin.password_hash)) {
    return res.status(401).json({ error: "بيانات الدخول غير صحيحة" });
  }
  res.json({
    token: jwt.sign({ id: admin.id, username: admin.username, role: admin.role }, JWT_SECRET, { expiresIn: "8h" }),
    username: admin.username,
    role: admin.role
  });
});

async function readStoreSettings() {
  const { rows } = await pool.query("SELECT key, value FROM store_settings");
  return Object.fromEntries(rows.map(({ key, value }) => [key, value]));
}

function parseCampaignImageIds(value) {
  const ids = JSON.parse(value || "[]");
  if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id))) {
    throw new Error("Saved campaign image list is invalid");
  }
  return ids;
}

async function categoryIconIsValid(icon) {
  const result = await pool.query("SELECT 1 FROM category_icon_options WHERE id = $1", [icon]);
  return result.rowCount > 0;
}

function whatsappIsConfigured(value) {
  return value.length >= 10 && value.length <= 15 && value !== "21600000000";
}

app.get("/api/config", async (req, res) => {
  try {
    const settings = await readStoreSettings();
    const whatsapp = settings.whatsapp || "";
    const heroCardX = Number(settings.hero_card_x);
    const heroCardY = Number(settings.hero_card_y);
    const heroOverlay = Number(settings.hero_overlay);
    const heroPriceSize = Number(settings.hero_price_size);
    const productColumns = Number(settings.product_columns);
    const categoryColumns = Number(settings.category_columns);
    res.json({
      whatsapp: whatsappIsConfigured(whatsapp) ? whatsapp : "",
      whatsappConfigured: whatsappIsConfigured(whatsapp),
      contactPhone: settings.contact_phone || "",
      contactEmail: settings.contact_email || "",
      contactAddress: settings.contact_address || "",
      openingHours: settings.opening_hours || "",
      socialFacebook: settings.social_facebook || "",
      socialInstagram: settings.social_instagram || "",
      socialTiktok: settings.social_tiktok || "",
      campaignImages: parseCampaignImageIds(settings.campaign_images).map(id => ({
        id,
        url: `/api/store-assets/campaign/${id}`
      })),
      heroBackgroundUrl: settings.hero_background_url || "",
      heroLogoUrl: settings.hero_logo_url || "",
      mobileLogoUrl: settings.mobile_logo_url || "",
      heroCardX: Number.isFinite(heroCardX) ? heroCardX : 0,
      heroCardY: Number.isFinite(heroCardY) ? heroCardY : 0,
      heroOverlay: Number.isFinite(heroOverlay) ? heroOverlay : 15,
      heroPriceSize: Number.isFinite(heroPriceSize) ? heroPriceSize : 29,
      productColumns: Number.isInteger(productColumns) && productColumns >= 2 && productColumns <= 6 ? productColumns : 4,
      categoryColumns: Number.isInteger(categoryColumns) && categoryColumns >= 2 && categoryColumns <= 6 ? categoryColumns : 4,
      store: STORE,
      currency: CURRENCY
    });
  } catch (error) {
    console.error("Could not load public store settings:", error);
    res.status(500).json({ error: "Could not load store configuration" });
  }
});

app.get("/api/store-assets/hero-background", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT image_data, content_type FROM store_assets WHERE asset_key = 'hero_background'"
    );
    const asset = rows[0];
    if (!asset?.image_data || !asset.content_type) {
      return res.status(404).json({ error: "Hero background image not found" });
    }
    res.set({
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff"
    }).type(asset.content_type).send(asset.image_data);
  } catch (error) {
    console.error("Could not load saved storefront background image:", error);
    res.status(500).json({ error: "Could not load hero background image" });
  }
});

app.get("/api/store-assets/hero-background-draft", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT image_data, content_type FROM store_assets WHERE asset_key = 'hero_background_draft'"
    );
    const asset = rows[0];
    if (!asset?.image_data || !asset.content_type) {
      return res.status(404).json({ error: "Draft hero background image not found" });
    }
    res.set({
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff"
    }).type(asset.content_type).send(asset.image_data);
  } catch (error) {
    console.error("Could not load draft storefront background image:", error);
    res.status(500).json({ error: "Could not load draft hero background image" });
  }
});

app.get("/api/store-assets/campaign/:id", async (req, res) => {
  const { id } = req.params;
  if (!/^[a-f0-9]{32}$/.test(id)) return res.status(404).json({ error: "Campaign image not found" });
  try {
    const { rows } = await pool.query(
      `SELECT image_data, content_type FROM store_assets
       WHERE asset_key = ANY($1::text[])
       ORDER BY CASE WHEN asset_key = $2 THEN 0 ELSE 1 END
       LIMIT 1`,
      [[`campaign_${id}`, `draft_campaign_${id}`], `campaign_${id}`]
    );
    const asset = rows[0];
    if (!asset?.image_data || !asset.content_type) {
      return res.status(404).json({ error: "Campaign image not found" });
    }
    res.set({
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff"
    }).type(asset.content_type).send(asset.image_data);
  } catch (error) {
    console.error("Could not load campaign slide image:", error);
    res.status(500).json({ error: "Could not load campaign image" });
  }
});

app.get("/api/navigation-links", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, label_ar, label_fr, href FROM store_navigation_links ORDER BY position, id"
    );
    res.json(rows);
  } catch (error) {
    console.error("Could not load storefront navigation links:", error);
    res.status(500).json({ error: "Could not load navigation links" });
  }
});

app.get("/api/admin/category-icons", auth, role("admin"), async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, label_ar, label_fr, icon_type FROM category_icon_options ORDER BY position, id"
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Could not load category icon options:", error);
    res.status(500).json({ error: "Could not load category icon options" });
  }
});

app.put("/api/admin/category-icons", auth, role("admin"), async (req, res) => {
  const options = req.body.options;
  if (!Array.isArray(options) || options.length < 1 || options.length > 20) {
    return res.status(400).json({ error: "Provide between 1 and 20 category icon options" });
  }
  const normalizedOptions = [];
  const ids = new Set();
  for (const option of options) {
    if (!option || typeof option !== "object" || Array.isArray(option)) {
      return res.status(400).json({ error: "Invalid category icon option" });
    }
    const id = typeof option.id === "string" ? option.id.trim() : "";
    const labelAr = typeof option.label_ar === "string" ? option.label_ar.trim() : "";
    const labelFr = typeof option.label_fr === "string" ? option.label_fr.trim() : "";
    const iconType = typeof option.icon_type === "string" ? option.icon_type : "";
    if (!/^(?:tag|clothing|bag|watch|accessory|custom_[a-z0-9_-]{1,48})$/.test(id) ||
        ids.has(id) || !labelAr || labelAr.length > 40 || !labelFr || labelFr.length > 40 ||
        !CATEGORY_ICON_TYPES.has(iconType)) {
      return res.status(400).json({ error: "Invalid category icon option fields" });
    }
    ids.add(id);
    normalizedOptions.push({ id, labelAr, labelFr, iconType });
  }

  const fallbackId = ids.has("tag") ? "tag" : normalizedOptions[0].id;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("LOCK TABLE categories IN SHARE ROW EXCLUSIVE MODE");
    await client.query(
      "UPDATE categories SET icon = $1 WHERE NOT (icon = ANY($2::text[]))",
      [fallbackId, [...ids]]
    );
    await client.query("DELETE FROM category_icon_options");
    await client.query(
      `INSERT INTO category_icon_options(id, label_ar, label_fr, icon_type, position)
       SELECT id, label_ar, label_fr, icon_type, position
       FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[]) WITH ORDINALITY
         AS icon_option(id, label_ar, label_fr, icon_type, position)`,
      [
        normalizedOptions.map(option => option.id),
        normalizedOptions.map(option => option.labelAr),
        normalizedOptions.map(option => option.labelFr),
        normalizedOptions.map(option => option.iconType)
      ]
    );
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Could not save category icon options:", error);
    res.status(500).json({ error: "Could not save category icon options" });
  } finally {
    client.release();
  }
});

app.put("/api/admin/navigation-links", auth, role("admin"), async (req, res) => {
  const links = req.body.links;
  if (!Array.isArray(links) || links.length > 12) {
    return res.status(400).json({ error: "Provide no more than 12 navigation links" });
  }
  const normalizedLinks = [];
  for (const link of links) {
    if (!link || typeof link !== "object" || Array.isArray(link)) {
      return res.status(400).json({ error: "Invalid navigation link" });
    }
    const labelAr = typeof link.label_ar === "string" ? link.label_ar.trim() : "";
    const labelFr = typeof link.label_fr === "string" ? link.label_fr.trim() : "";
    const href = typeof link.href === "string" ? link.href.trim() : "";
    if (!labelAr || labelAr.length > 60 || !labelFr || labelFr.length > 60) {
      return res.status(400).json({ error: "Each navigation link needs Arabic and French labels (up to 60 characters)" });
    }
    if (href.length > 500 || /[\u0000-\u0020]/.test(href)) {
      return res.status(400).json({ error: "Invalid navigation link URL" });
    }
    const isAnchor = href === "#" || /^#[A-Za-z][A-Za-z0-9_-]*$/.test(href);
    const isLocalPath = /^\/(?!\/)/.test(href) && !href.includes("\\");
    let isHttpsUrl = false;
    if (!isAnchor && !isLocalPath) {
      try {
        const url = new URL(href);
        isHttpsUrl = url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
      } catch {
        isHttpsUrl = false;
      }
    }
    if (!isAnchor && !isLocalPath && !isHttpsUrl) {
      return res.status(400).json({ error: "Link must be an anchor, a local path, or a valid HTTPS URL" });
    }
    normalizedLinks.push({ labelAr, labelFr, href });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM store_navigation_links");
    if (normalizedLinks.length) {
      await client.query(
        `INSERT INTO store_navigation_links(label_ar, label_fr, href, position)
         SELECT label_ar, label_fr, href, ordinal - 1
         FROM UNNEST($1::text[], $2::text[], $3::text[]) WITH ORDINALITY
           AS link(label_ar, label_fr, href, ordinal)`,
        [
          normalizedLinks.map(link => link.labelAr),
          normalizedLinks.map(link => link.labelFr),
          normalizedLinks.map(link => link.href)
        ]
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Could not save storefront navigation links:", error);
    res.status(500).json({ error: "Could not save navigation links" });
  } finally {
    client.release();
  }
});

app.get("/api/admin/settings", auth, role("admin"), async (req, res) => {
  try {
    const settings = await readStoreSettings();
    const draftCampaignImages = settings.draft_campaign_images ?? settings.campaign_images;
    res.json({
      whatsapp: settings.whatsapp || "",
      contact_phone: settings.contact_phone || "",
      contact_email: settings.contact_email || "",
      contact_address: settings.contact_address || "",
      opening_hours: settings.opening_hours || "",
      social_facebook: settings.social_facebook || "",
      social_instagram: settings.social_instagram || "",
      social_tiktok: settings.social_tiktok || "",
      campaign_images: parseCampaignImageIds(draftCampaignImages).map(id => ({
        id,
        url: `/api/store-assets/campaign/${id}`
      })),
      hero_background_url: settings.draft_hero_background_url ?? settings.hero_background_url ?? "",
      hero_logo_url: settings.draft_hero_logo_url ?? settings.hero_logo_url ?? "",
      mobile_logo_url: settings.draft_mobile_logo_url ?? settings.mobile_logo_url ?? "",
      hero_card_x: settings.draft_hero_card_x ?? settings.hero_card_x ?? "0",
      hero_card_y: settings.draft_hero_card_y ?? settings.hero_card_y ?? "0",
      hero_overlay: settings.draft_hero_overlay ?? settings.hero_overlay ?? "15",
      hero_price_size: settings.draft_hero_price_size ?? settings.hero_price_size ?? "29",
      product_columns: settings.draft_product_columns ?? settings.product_columns ?? "4",
      category_columns: settings.draft_category_columns ?? settings.category_columns ?? "4",
      hero_settings_has_draft: HERO_DRAFT_SETTINGS.some(key => settings[`draft_${key}`] !== undefined) ||
        settings.draft_campaign_images !== undefined
    });
  } catch (error) {
    console.error("Could not load administrator store settings:", error);
    res.status(500).json({ error: "Could not load store settings" });
  }
});

app.put("/api/admin/settings", auth, role("admin"), async (req, res) => {
  const fields = {
    whatsapp: 15,
    contact_phone: 40,
    contact_email: 254,
    contact_address: 500,
    opening_hours: 160,
    social_facebook: 500,
    social_instagram: 500,
    social_tiktok: 500,
    hero_background_url: 2000,
    hero_logo_url: 2000
  };
  const settings = {};
  for (const [key, maxLength] of Object.entries(fields)) {
    if (typeof req.body[key] !== "string") {
      return res.status(400).json({ error: `Invalid ${key}` });
    }
    const value = req.body[key].trim();
    if (value.length > maxLength) {
      return res.status(400).json({ error: `${key} is too long` });
    }
    settings[key] = value;
  }
  settings.whatsapp = settings.whatsapp.replace(/\D/g, "");
  if (settings.whatsapp && !whatsappIsConfigured(settings.whatsapp)) {
    return res.status(400).json({ error: "WhatsApp must be an international number with 10 to 15 digits" });
  }
  if (settings.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(settings.contact_email)) {
    return res.status(400).json({ error: "Invalid contact email" });
  }
  for (const key of ["social_facebook", "social_instagram", "social_tiktok"]) {
    if (!settings[key]) continue;
    let url;
    try {
      url = new URL(settings[key]);
    } catch {
      return res.status(400).json({ error: `Invalid ${key} URL` });
    }
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
      return res.status(400).json({ error: `${key} must be a valid HTTPS URL` });
    }
    settings[key] = url.toString();
  }
  if (req.body.mobile_logo_url !== undefined) {
    if (typeof req.body.mobile_logo_url !== "string") {
      return res.status(400).json({ error: "Invalid mobile_logo_url" });
    }
    settings.mobile_logo_url = req.body.mobile_logo_url.trim();
    if (settings.mobile_logo_url.length > 2000) {
      return res.status(400).json({ error: "mobile_logo_url is too long" });
    }
  }
  for (const key of ["hero_background_url", "hero_logo_url", "mobile_logo_url"]) {
    if (settings[key] === undefined) continue;
    if (key === "hero_background_url" &&
      ["/api/store-assets/hero-background", "/api/store-assets/hero-background-draft", "/hero-background.png"].includes(settings[key])) continue;
    if (!settings[key] || /^\/uploads\/[A-Za-z0-9._-]+$/.test(settings[key])) continue;
    let url;
    try {
      url = new URL(settings[key]);
    } catch {
      return res.status(400).json({ error: `Invalid ${key}` });
    }
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
      return res.status(400).json({ error: `${key} must be a valid HTTPS URL or uploaded image path` });
    }
    settings[key] = url.toString();
  }
  const draftSettings = {};
  for (const [key, min, max] of [
    ["hero_card_x", -200, 200],
    ["hero_card_y", -200, 200],
    ["hero_overlay", 0, 80],
    ["hero_price_size", 16, 56]
  ]) {
    const value = req.body[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      return res.status(400).json({ error: `Invalid ${key}` });
    }
    draftSettings[`draft_${key}`] = String(value);
  }
  if (!Number.isInteger(req.body.product_columns) || req.body.product_columns < 2 || req.body.product_columns > 6) {
    return res.status(400).json({ error: "Invalid product_columns" });
  }
  draftSettings.draft_product_columns = String(req.body.product_columns);
  if (!Number.isInteger(req.body.category_columns) || req.body.category_columns < 2 || req.body.category_columns > 6) {
    return res.status(400).json({ error: "Invalid category_columns" });
  }
  draftSettings.draft_category_columns = String(req.body.category_columns);

  draftSettings.draft_hero_background_url = settings.hero_background_url;
  draftSettings.draft_hero_logo_url = settings.hero_logo_url;
  if (settings.mobile_logo_url !== undefined) {
    draftSettings.draft_mobile_logo_url = settings.mobile_logo_url;
  }
  for (const key of ["hero_background_url", "hero_logo_url", "mobile_logo_url"]) delete settings[key];

  const entries = [...Object.entries(settings), ...Object.entries(draftSettings)];
  try {
    await pool.query(
      `INSERT INTO store_settings(key, value)
       SELECT key, value FROM UNNEST($1::text[], $2::text[]) AS setting(key, value)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [entries.map(([key]) => key), entries.map(([, value]) => value)]
    );
    res.json({ ok: true });
  } catch (error) {
    console.error("Could not save administrator store settings:", error);
    res.status(500).json({ error: "Could not save store settings" });
  }
});

app.post("/api/admin/settings/activate", auth, role("admin"), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const draftKeys = [...HERO_DRAFT_SETTINGS.map(key => `draft_${key}`), "draft_campaign_images"];
    const { rows } = await client.query(
      "SELECT key, value FROM store_settings WHERE key = ANY($1::text[]) FOR UPDATE",
      [draftKeys]
    );
    if (!rows.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Save slider changes before activating them" });
    }
    const draft = Object.fromEntries(rows.map(({ key, value }) => [key, value]));
    if (draft.draft_campaign_images !== undefined) {
      const campaignIds = parseCampaignImageIds(draft.draft_campaign_images);
      if (campaignIds.length > MAX_CUSTOM_CAMPAIGN_IMAGE_COUNT) {
        throw new Error("Draft campaign image list exceeds the supported limit");
      }
      for (const id of campaignIds) {
        const { rows: assets } = await client.query(
          `SELECT asset_key, image_data, content_type FROM store_assets
           WHERE asset_key = ANY($1::text[])
           ORDER BY CASE WHEN asset_key = $2 THEN 0 ELSE 1 END
           LIMIT 1`,
          [[`draft_campaign_${id}`, `campaign_${id}`], `draft_campaign_${id}`]
        );
        const asset = assets[0];
        if (!asset?.image_data || !asset.content_type) {
          throw new Error(`Draft campaign image ${id} is missing`);
        }
        await client.query(
          `INSERT INTO store_assets(asset_key, image_data, content_type)
           VALUES($1, $2, $3)
           ON CONFLICT (asset_key) DO UPDATE
             SET image_data = EXCLUDED.image_data,
                 content_type = EXCLUDED.content_type,
                 updated_at = NOW()`,
          [`campaign_${id}`, asset.image_data, asset.content_type]
        );
      }
      await client.query(
        `DELETE FROM store_assets
         WHERE asset_key ~ '^campaign_[a-f0-9]{32}$'
           AND asset_key <> ALL($1::text[])`,
        [campaignIds.map(id => `campaign_${id}`)]
      );
      await client.query(
        `INSERT INTO store_settings(key, value) VALUES('campaign_images', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [JSON.stringify(campaignIds)]
      );
    }
    for (const key of HERO_DRAFT_SETTINGS) {
      const draftKey = `draft_${key}`;
      if (draft[draftKey] === undefined) continue;
      let value = draft[draftKey];
      if (key === "hero_background_url" && value === "/api/store-assets/hero-background-draft") {
        const { rows: backgroundRows } = await client.query(
          "SELECT image_data, content_type FROM store_assets WHERE asset_key = 'hero_background_draft'"
        );
        const background = backgroundRows[0];
        if (!background?.image_data || !background.content_type) {
          throw new Error("Draft hero background image is missing");
        }
        await client.query(
          `INSERT INTO store_assets(asset_key, image_data, content_type)
           VALUES('hero_background', $1, $2)
           ON CONFLICT (asset_key) DO UPDATE
             SET image_data = EXCLUDED.image_data,
                 content_type = EXCLUDED.content_type,
                 updated_at = NOW()`,
          [background.image_data, background.content_type]
        );
        value = "/api/store-assets/hero-background";
      }
      await client.query(
        `INSERT INTO store_settings(key, value) VALUES($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, value]
      );
    }
    await client.query(
      "DELETE FROM store_settings WHERE key = ANY($1::text[])",
      [draftKeys]
    );
    await client.query(
      "DELETE FROM store_assets WHERE asset_key = 'hero_background_draft' OR asset_key ~ '^draft_campaign_[a-f0-9]{32}$'"
    );
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Could not activate draft storefront hero settings:", error);
    res.status(500).json({ error: "Could not activate slider settings" });
  } finally {
    client.release();
  }
});

app.post("/api/admin/settings/hero-background", auth, role("admin"), heroBackgroundUpload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Select an image to upload" });
  const imagePath = "/api/store-assets/hero-background-draft";
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO store_assets(asset_key, image_data, content_type)
         VALUES('hero_background_draft', $1, $2)
         ON CONFLICT (asset_key) DO UPDATE
           SET image_data = EXCLUDED.image_data,
               content_type = EXCLUDED.content_type,
               updated_at = NOW()`,
        [req.file.buffer, req.file.mimetype]
      );
      await client.query(
        `INSERT INTO store_settings(key, value) VALUES('draft_hero_background_url', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [imagePath]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    res.json({ ok: true, hero_background_url: imagePath });
  } catch (error) {
    console.error("Could not save storefront hero background image:", error);
    res.status(500).json({ error: "Could not save hero background image" });
  }
});
app.post("/api/admin/settings/campaign-images", auth, role("admin"), campaignImagesUpload.array("images", MAX_CUSTOM_CAMPAIGN_IMAGE_COUNT), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: "Select at least one image to upload" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO store_settings(key, value)
       SELECT 'draft_campaign_images', COALESCE(
         (SELECT value FROM store_settings WHERE key = 'campaign_images'), '[]'
       )
       ON CONFLICT (key) DO NOTHING`
    );
    const { rows } = await client.query(
      `SELECT key, value FROM store_settings
       WHERE key IN ('draft_campaign_images', 'campaign_images')
       ORDER BY key FOR UPDATE`
    );
    const currentIds = parseCampaignImageIds(rows.find(row => row.key === "draft_campaign_images")?.value);
    if (DEFAULT_CAMPAIGN_IMAGE_COUNT + currentIds.length + files.length > MAX_CAMPAIGN_IMAGE_COUNT) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: `The slideshow supports up to ${MAX_CAMPAIGN_IMAGE_COUNT} images, including its ${DEFAULT_CAMPAIGN_IMAGE_COUNT} default images`
      });
    }
    const ids = files.map(() => crypto.randomBytes(16).toString("hex"));
    for (let index = 0; index < files.length; index++) {
      await client.query(
        `INSERT INTO store_assets(asset_key, image_data, content_type)
         VALUES($1, $2, $3)`,
        [`draft_campaign_${ids[index]}`, files[index].buffer, files[index].mimetype]
      );
    }
    const nextIds = [...currentIds, ...ids];
    await client.query(
      `UPDATE store_settings SET value = $1 WHERE key = 'draft_campaign_images'`,
      [JSON.stringify(nextIds)]
    );
    await client.query("COMMIT");
    res.json({
      ok: true,
      campaign_images: nextIds.map(id => ({ id, url: `/api/store-assets/campaign/${id}` })),
      total_images: DEFAULT_CAMPAIGN_IMAGE_COUNT + nextIds.length,
      max_images: MAX_CAMPAIGN_IMAGE_COUNT
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Could not upload campaign slideshow images:", error);
    res.status(500).json({ error: "Could not save campaign slideshow images" });
  } finally {
    client.release();
  }
});
app.delete("/api/admin/settings/campaign-images/:id", auth, role("admin"), async (req, res) => {
  const { id } = req.params;
  if (!/^[a-f0-9]{32}$/.test(id)) return res.status(400).json({ error: "Invalid campaign image ID" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO store_settings(key, value)
       SELECT 'draft_campaign_images', COALESCE(
         (SELECT value FROM store_settings WHERE key = 'campaign_images'), '[]'
       )
       ON CONFLICT (key) DO NOTHING`
    );
    const { rows } = await client.query(
      `SELECT key, value FROM store_settings
       WHERE key IN ('draft_campaign_images', 'campaign_images')
       ORDER BY key FOR UPDATE`
    );
    const currentIds = parseCampaignImageIds(rows.find(row => row.key === "draft_campaign_images")?.value);
    if (!currentIds.includes(id)) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Campaign image not found" });
    }
    const nextIds = currentIds.filter(currentId => currentId !== id);
    await client.query(
      "UPDATE store_settings SET value = $1 WHERE key = 'draft_campaign_images'",
      [JSON.stringify(nextIds)]
    );
    await client.query("DELETE FROM store_assets WHERE asset_key = $1", [`draft_campaign_${id}`]);
    await client.query("COMMIT");
    res.json({
      ok: true,
      campaign_images: nextIds.map(currentId => ({
        id: currentId,
        url: `/api/store-assets/campaign/${currentId}`
      })),
      total_images: DEFAULT_CAMPAIGN_IMAGE_COUNT + nextIds.length,
      max_images: MAX_CAMPAIGN_IMAGE_COUNT
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Could not delete campaign slideshow image:", error);
    res.status(500).json({ error: "Could not delete campaign image" });
  } finally {
    client.release();
  }
});
app.post("/api/admin/settings/hero-logo", auth, role("admin"), upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Select an image to upload" });
  const imagePath = `/uploads/${req.file.filename}`;
  try {
    await pool.query(
      `INSERT INTO store_settings(key, value) VALUES('draft_hero_logo_url', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [imagePath]
    );
    res.json({ ok: true, hero_logo_url: imagePath });
  } catch (error) {
    console.error("Could not save storefront hero logo image:", error);
    try {
      await fs.promises.unlink(path.join(uploadDir, req.file.filename));
    } catch (cleanupError) {
      console.error("Could not remove the failed hero logo upload:", cleanupError);
    }
    res.status(500).json({ error: "Could not save hero logo image" });
  }
});
app.post("/api/admin/settings/mobile-logo", auth, role("admin"), upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Select a logo image to upload" });
  const imagePath = `/uploads/${req.file.filename}`;
  try {
    await pool.query(
      `INSERT INTO store_settings(key, value) VALUES('draft_mobile_logo_url', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [imagePath]
    );
    res.json({ ok: true, mobile_logo_url: imagePath });
  } catch (error) {
    console.error("Could not save draft mobile menu logo:", error);
    try {
      await fs.promises.unlink(path.join(uploadDir, req.file.filename));
    } catch (cleanupError) {
      console.error("Could not remove the failed mobile logo upload:", cleanupError);
    }
    res.status(500).json({ error: "Could not save mobile menu logo" });
  }
});
app.get("/api/admin/events", auth, (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders();
  adminEventClients.add(res);
  res.write("event: ready\ndata: {}\n\n");
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 25000);
  req.on("close", () => {
    clearInterval(keepAlive);
    adminEventClients.delete(res);
  });
});
app.get("/api/categories", async (req, res) => {
  const result = await pool.query(
    `SELECT c.id, c.name, c.parent_id, COALESCE(icon.icon_type, 'tag') AS icon
     FROM categories c
     LEFT JOIN categories parent ON parent.id = c.parent_id
     LEFT JOIN category_icon_options icon ON icon.id = c.icon
     WHERE c.active = TRUE AND (c.parent_id IS NULL OR parent.active = TRUE)
     ORDER BY c.sort_order, c.id`
  );
  res.json(result.rows);
});
app.get("/api/admin/categories", auth, async (req, res) => {
  const result = await pool.query(
    `SELECT c.id, c.name, c.parent_id, c.icon, c.active, c.sort_order,
       COUNT(DISTINCT p.id)::INTEGER AS product_count,
       COUNT(DISTINCT p.id) FILTER (WHERE p.category_id = c.id)::INTEGER AS direct_product_count
     FROM categories c
     LEFT JOIN products p ON p.category_id = c.id OR p.category_id IN (
       SELECT child.id FROM categories child WHERE child.parent_id = c.id
     )
     GROUP BY c.id ORDER BY c.sort_order, c.id`
  );
  res.json(result.rows);
});
app.get("/api/advertisement", async (req, res) => {
  const products = await productRows();
  // Keep sold-out products visible in the featured carousel; the storefront disables ordering.
  products.sort((left, right) => Number(right.advertised) - Number(left.advertised));
  res.json(products);
});
app.post("/api/categories", auth, role("admin"), async (req, res) => {
  const name = String(req.body.name || "").trim();
  const icon = String(req.body.icon || "tag");
  const parentId = req.body.parent_id == null || req.body.parent_id === "" ? null : Number(req.body.parent_id);
  if (!name || name.length > 100) return res.status(400).json({ error: "اسم القسم مطلوب (حتى 100 حرف)" });
  if (!await categoryIconIsValid(icon)) {
    return res.status(400).json({ error: "أيقونة القسم غير صالحة" });
  }
  if (parentId !== null && (!Number.isInteger(parentId) || parentId < 1)) {
    return res.status(400).json({ error: "القسم الأب غير صالح" });
  }
  if (parentId !== null) {
    const parent = await pool.query("SELECT id FROM categories WHERE id = $1 AND parent_id IS NULL", [parentId]);
    if (!parent.rowCount) return res.status(400).json({ error: "يجب اختيار قسم أب رئيسي صالح" });
  }
  try {
    const result = await pool.query(
      `INSERT INTO categories(name, icon, parent_id, sort_order)
       VALUES($1, $2, $3, COALESCE((SELECT MAX(sort_order) + 1 FROM categories), 0))
       RETURNING id`,
      [name, icon, parentId]
    );
    res.status(201).json({ id: result.rows[0].id });
  } catch (error) {
    if (error.code === "23505") return res.status(400).json({ error: "القسم موجود بالفعل" });
    if (error.code === "23503") return res.status(400).json({ error: "أيقونة القسم غير متاحة" });
    throw error;
  }
});
app.put("/api/categories/order", auth, role("admin"), async (req, res) => {
  const ids = req.body.ids;
  if (!Array.isArray(ids) || ids.some(id => !Number.isInteger(id) || id < 1) ||
      new Set(ids).size !== ids.length) {
    return res.status(400).json({ error: "ترتيب الأقسام غير صالح" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query("SELECT id FROM categories ORDER BY sort_order, id FOR UPDATE");
    const currentIds = current.rows.map(row => row.id);
    if (ids.length !== currentIds.length || ids.some(id => !currentIds.includes(id))) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "تغيرت الأقسام. حدّث القائمة ثم أعد المحاولة." });
    }
    await client.query(
      `UPDATE categories AS c SET sort_order = ordered.ordinality - 1
       FROM unnest($1::INTEGER[]) WITH ORDINALITY AS ordered(id, ordinality)
       WHERE c.id = ordered.id`,
      [ids]
    );
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});
app.put("/api/categories/:id", auth, role("admin"), async (req, res) => {
  const id = Number(req.params.id);
  const name = String(req.body.name || "").trim();
  const icon = String(req.body.icon || "");
  const active = req.body.active;
  const parentId = req.body.parent_id == null || req.body.parent_id === "" ? null : Number(req.body.parent_id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "معرّف القسم غير صالح" });
  if (!name || name.length > 100) return res.status(400).json({ error: "اسم القسم مطلوب (حتى 100 حرف)" });
  if (!await categoryIconIsValid(icon)) {
    return res.status(400).json({ error: "أيقونة القسم غير صالحة" });
  }
  if (typeof active !== "boolean") return res.status(400).json({ error: "حالة القسم غير صالحة" });
  if (parentId !== null && (!Number.isInteger(parentId) || parentId < 1 || parentId === id)) {
    return res.status(400).json({ error: "القسم الأب غير صالح" });
  }
  if (parentId !== null) {
    const parent = await pool.query("SELECT id FROM categories WHERE id = $1 AND parent_id IS NULL", [parentId]);
    if (!parent.rowCount) return res.status(400).json({ error: "يجب اختيار قسم أب رئيسي صالح" });
    const children = await pool.query("SELECT 1 FROM categories WHERE parent_id = $1 LIMIT 1", [id]);
    if (children.rowCount) return res.status(400).json({ error: "لا يمكن إدراج قسم رئيسي تابعاً لقسم آخر" });
  }
  try {
    const result = await pool.query(
      "UPDATE categories SET name = $1, icon = $2, active = $3, parent_id = $4 WHERE id = $5 RETURNING id",
      [name, icon, active, parentId, id]
    );
    if (!result.rowCount) return res.status(404).json({ error: "القسم غير موجود" });
    res.json({ ok: true });
  } catch (error) {
    if (error.code === "23505") return res.status(400).json({ error: "القسم موجود بالفعل" });
    if (error.code === "23503") return res.status(400).json({ error: "أيقونة القسم غير متاحة" });
    throw error;
  }
});
app.delete("/api/categories/:id", auth, role("admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "معرّف القسم غير صالح" });
  const result = await pool.query("DELETE FROM categories WHERE id = $1", [id]);
  if (!result.rowCount) return res.status(404).json({ error: "القسم غير موجود" });
  res.json({ ok: true });
});

app.get("/api/products", async (req, res) => {
  let products = await productRows();
  const query = String(req.query.q || "").trim().toLowerCase();
  const category = req.query.category;
  if (query) products = products.filter(product =>
    `${product.name} ${product.description} ${product.category_name || ""}`.toLowerCase().includes(query)
  );
  if (category) {
    const categoryId = Number(category);
    if (!Number.isInteger(categoryId) || categoryId < 1) {
      products = [];
    } else {
      const descendants = await pool.query(
        `WITH RECURSIVE category_tree(id) AS (
           SELECT id FROM categories WHERE id = $1 AND active = TRUE
           UNION ALL
           SELECT child.id FROM categories child
           JOIN category_tree parent ON child.parent_id = parent.id
           WHERE child.active = TRUE
         )
         SELECT id FROM category_tree`,
        [categoryId]
      );
      const categoryIds = new Set(descendants.rows.map(row => String(row.id)));
      products = products.filter(product => categoryIds.has(String(product.category_id)));
    }
  }
  res.json(products);
});
app.get("/api/admin/products", auth, async (req, res) => res.json(await productRows(true)));
app.put("/api/products/order", auth, role("admin", "manager"), async (req, res) => {
  const ids = req.body.ids;
  if (!Array.isArray(ids) || ids.some(id => !Number.isInteger(id) || id < 1) ||
      new Set(ids).size !== ids.length) {
    return res.status(400).json({ error: "ترتيب المنتجات غير صالح" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("LOCK TABLE products IN SHARE ROW EXCLUSIVE MODE");
    const current = await client.query("SELECT id FROM products ORDER BY id DESC");
    const currentIds = current.rows.map(row => row.id);
    if (ids.length !== currentIds.length || ids.some(id => !currentIds.includes(id))) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "تغيرت المنتجات. حدّث القائمة ثم أعد المحاولة." });
    }
    await client.query(
      `UPDATE products AS p SET sort_order = ordered.ordinality - 1
       FROM unnest($1::INTEGER[]) WITH ORDINALITY AS ordered(id, ordinality)
       WHERE p.id = ordered.id`,
      [ids]
    );
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

async function loadInventoryReport() {
  const [summary, stockLevels, topProducts, movements] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE active = TRUE)::int AS active_products,
       COALESCE(SUM(stock) FILTER (WHERE active = TRUE), 0)::bigint AS units_in_stock,
       COUNT(*) FILTER (WHERE active = TRUE AND stock = 0)::int AS out_of_stock
       FROM products`
    ),
    pool.query(
      `SELECT p.id, p.name, c.name AS category_name, p.stock
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.active = TRUE ORDER BY p.stock ASC, p.name, p.id`
    ),
    pool.query(
      `SELECT oi.product_id, oi.product_name, COALESCE(SUM(oi.quantity), 0)::bigint AS units_sold
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.status NOT IN ('cancelled', 'returned') AND o.inventory_deducted = TRUE
       GROUP BY oi.product_id, oi.product_name
       ORDER BY units_sold DESC, oi.product_name ASC LIMIT 10`
    ),
    pool.query(
      `SELECT m.id, m.product_name, m.movement_type, m.quantity_change, m.stock_before,
       m.stock_after, m.actor, m.order_id, m.created_at, c.name AS category_name
       FROM inventory_movements m
       LEFT JOIN products p ON p.id = m.product_id
       LEFT JOIN categories c ON c.id = p.category_id
       ORDER BY m.created_at DESC, m.id DESC LIMIT 200`
    )
  ]);
  return {
    summary: summary.rows[0],
    stockLevels: stockLevels.rows,
    outOfStock: stockLevels.rows.filter(product => Number(product.stock) === 0),
    topProducts: topProducts.rows,
    movements: movements.rows
  };
}

function inventoryMovementLabel(type) {
  return ({
    initial: "Stock initial",
    restock: "Réapprovisionnement",
    adjustment: "Ajustement",
    sale: "Vente"
  })[type] || type;
}

app.get("/api/admin/inventory", auth, role("admin", "manager"), async (req, res) => {
  res.json(await loadInventoryReport());
});

app.get("/api/admin/inventory/export.csv", auth, role("admin", "manager"), async (req, res) => {
  const report = await loadInventoryReport();
  const rows = [
    ["Rapport", "Produit", "Catégorie", "Stock", "Variation", "Avant", "Après", "Type", "Référence", "Effectué par", "Date"],
    ...report.stockLevels.map(item => ["Stock actuel", item.name, item.category_name || "", item.stock, "", "", "", "", "", "", ""]),
    ...report.outOfStock.map(item => ["Rupture", item.name, item.category_name || "", item.stock, "", "", "", "", "", "", ""]),
    ...report.topProducts.map(item => ["Meilleures ventes", item.product_name, "", "", item.units_sold, "", "", "", "", "", ""]),
    ...report.movements.map(item => [
      "Mouvement", item.product_name, item.category_name || "", item.stock_after,
      item.quantity_change, item.stock_before, item.stock_after, inventoryMovementLabel(item.movement_type),
      item.order_id ? `#${item.order_id}` : "", item.actor, new Date(item.created_at).toISOString()
    ])
  ];
  const csv = `\uFEFF${rows.map(row => row.map(value => `"${String(value ?? "").replace(/"/g, '""')}"`).join(";")).join("\r\n")}`;
  res.type("text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="inventory-report.csv"');
  res.send(csv);
});

app.get("/api/admin/inventory/export.pdf", auth, role("admin", "manager"), async (req, res) => {
  const report = await loadInventoryReport();
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'attachment; filename="inventory-report.pdf"');
  const document = new PDFDocument({ size: "A4", margin: 44, bufferPages: true });
  document.pipe(res);
  const left = 44;
  const pageWidth = document.page.width - 88;
  let y = 48;
  const ensureSpace = (height = 24) => {
    if (y + height > document.page.height - 48) {
      document.addPage();
      y = 48;
    }
  };
  const heading = title => {
    ensureSpace(36);
    document.fillColor("#172554").font("Helvetica-Bold").fontSize(13).text(title, left, y);
    y += 24;
  };
  const row = (values, widths, options = {}) => {
    const height = options.height || 22;
    ensureSpace(height);
    if (options.header) document.fillColor("#f1f5f9").rect(left, y - 3, pageWidth, height).fill();
    document.fillColor(options.header ? "#172554" : "#334155")
      .font(options.header ? "Helvetica-Bold" : "Helvetica").fontSize(options.header ? 8 : 8);
    let x = left + 5;
    values.forEach((value, index) => {
      document.text(String(value ?? "-"), x, y, {
        width: widths[index] - 8, height: height - 3, ellipsis: true, lineBreak: false
      });
      x += widths[index];
    });
    y += height;
  };
  document.fillColor("#172554").rect(0, 0, document.page.width, 94).fill();
  document.fillColor("#ffffff").font("Helvetica-Bold").fontSize(21).text("M&D Store", left, 27);
  document.fillColor("#fbbf24").fontSize(12).text("RAPPORT DE STOCK", left, 59);
  y = 116;
  document.fillColor("#475569").font("Helvetica").fontSize(10)
    .text(`Produits actifs : ${report.summary.active_products}    |    Unités en stock : ${report.summary.units_in_stock}    |    En rupture : ${report.summary.out_of_stock}`, left, y);
  y += 30;
  heading("Etat actuel des stocks");
  row(["Produit", "Catégorie", "Stock"], [pageWidth * 0.5, pageWidth * 0.3, pageWidth * 0.2], { header: true });
  for (const item of report.stockLevels) {
    row([item.name, item.category_name || "-", item.stock], [pageWidth * 0.5, pageWidth * 0.3, pageWidth * 0.2]);
  }
  if (!report.stockLevels.length) row(["Aucun produit actif", "", ""], [pageWidth * 0.5, pageWidth * 0.3, pageWidth * 0.2]);
  y += 12;
  heading("Alertes de rupture");
  row(["Produit", "Catégorie", "Stock"], [pageWidth * 0.5, pageWidth * 0.3, pageWidth * 0.2], { header: true });
  if (report.outOfStock.length) {
    for (const item of report.outOfStock) row([item.name, item.category_name || "-", item.stock], [pageWidth * 0.5, pageWidth * 0.3, pageWidth * 0.2]);
  } else row(["Aucun produit en rupture", "", ""], [pageWidth * 0.5, pageWidth * 0.3, pageWidth * 0.2]);
  y += 12;
  heading("Top produits vendus (hors commandes annulees)");
  row(["Produit", "Unites vendues"], [pageWidth * 0.7, pageWidth * 0.3], { header: true });
  if (report.topProducts.length) {
    for (const item of report.topProducts) row([item.product_name, item.units_sold], [pageWidth * 0.7, pageWidth * 0.3]);
  } else row(["Aucune vente enregistree", ""], [pageWidth * 0.7, pageWidth * 0.3]);
  y += 12;
  heading("Derniers mouvements de stock");
  const movementWidths = [pageWidth * 0.25, pageWidth * 0.12, pageWidth * 0.11, pageWidth * 0.1, pageWidth * 0.12, pageWidth * 0.12, pageWidth * 0.18];
  row(["Produit", "Type", "Variation", "Apres", "Commande", "Auteur", "Date"], movementWidths, { header: true });
  if (report.movements.length) {
    for (const item of report.movements) {
      row([item.product_name, inventoryMovementLabel(item.movement_type), item.quantity_change, item.stock_after,
        item.order_id ? `#${item.order_id}` : "-", item.actor,
        new Date(item.created_at).toLocaleDateString("fr-TN")], movementWidths);
    }
  } else row(["Aucun mouvement enregistre", "", "", "", "", "", ""], movementWidths);
  document.end();
});

app.post("/api/products", auth, role("admin", "manager"), productUpload.array("images", 8), async (req, res) => {
  const product = parseProductInput(req.body);
  if (!product) return res.status(400).json({ error: "الاسم والسعر مطلوبان" });
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    if (product.advertised) {
      await client.query("UPDATE products SET advertised = FALSE WHERE advertised = TRUE");
    }
    const result = await client.query(
      `INSERT INTO products(name, description, category_id, price, cost_price, delivery_price, old_price, stock, colors, advertised, sort_order)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         CASE WHEN EXISTS (SELECT 1 FROM products WHERE sort_order IS NOT NULL)
           THEN COALESCE((SELECT MAX(sort_order) + 1 FROM products), 0) ELSE NULL END)
       RETURNING id`,
      [product.name, product.description, product.categoryId, product.price, product.costPrice, product.deliveryPrice,
        product.oldPrice, product.stock, product.colors, product.advertised]
    );
    const productId = result.rows[0].id;
    await insertProductImages(client, productId, req.files);
    if (product.stock > 0) {
      await client.query(
        `INSERT INTO inventory_movements(product_id, product_name, movement_type, quantity_change, stock_before, stock_after, actor)
         VALUES($1, $2, 'initial', $3, 0, $3, $4)`,
        [productId, product.name, product.stock, req.admin.username]
      );
    }
    await client.query("COMMIT");
    res.json({ id: productId });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Could not roll back product creation:", rollbackError);
      }
    }
    throw error;
  } finally {
    if (client) client.release();
  }
});

app.put("/api/products/:id", auth, role("admin", "manager"), productUpload.array("images", 8), async (req, res) => {
  const product = parseProductInput(req.body);
  if (!product) return res.status(400).json({ error: "الاسم والسعر مطلوبان" });
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const existing = await client.query("SELECT id, name, stock FROM products WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (!existing.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "المنتج غير موجود" });
    }
    if (product.advertised) {
      await client.query("UPDATE products SET advertised = FALSE WHERE advertised = TRUE AND id <> $1", [req.params.id]);
    }
    await client.query(
      `UPDATE products SET name=$1, description=$2, category_id=$3, price=$4, cost_price=$5, delivery_price=$6, old_price=$7,
       stock=$8, active=$9, advertised=$10, colors=$11 WHERE id=$12`,
      [product.name, product.description, product.categoryId, product.price, product.costPrice, product.deliveryPrice,
        product.oldPrice, product.stock, product.active, product.advertised, product.colors, req.params.id]
    );
    await insertProductImages(client, req.params.id, req.files);
    const previousProduct = existing.rows[0];
    if (previousProduct.stock !== product.stock) {
      await client.query(
        `INSERT INTO inventory_movements(product_id, product_name, movement_type, quantity_change, stock_before, stock_after, actor)
         VALUES($1, $2, $3, $4, $5, $6, $7)`,
        [req.params.id, product.name, product.stock > previousProduct.stock ? "restock" : "adjustment",
          product.stock - previousProduct.stock, previousProduct.stock, product.stock, req.admin.username]
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Could not roll back product update:", rollbackError);
      }
    }
    throw error;
  } finally {
    if (client) client.release();
  }
});
app.delete("/api/products/:id", auth, role("admin", "manager"), async (req, res) => {
  const productId = Number(req.params.id);
  if (!Number.isInteger(productId) || productId < 1) return res.status(400).json({ error: "معرّف المنتج غير صالح" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const product = await client.query("SELECT id FROM products WHERE id = $1 FOR UPDATE", [productId]);
    if (!product.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "المنتج غير موجود" });
    }
    await client.query("DELETE FROM products WHERE id = $1", [productId]);
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Could not roll back product deletion:", rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
  res.json({ ok: true });
});
app.delete("/api/products/:id/images/:imageId", auth, role("admin", "manager"), async (req, res) => {
  const result = await pool.query(
    "DELETE FROM product_images WHERE id = $1 AND product_id = $2 RETURNING id",
    [req.params.imageId, req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: "الصورة غير موجودة" });
  res.json({ ok: true });
});

app.post("/api/orders", async (req, res) => {
  const { customer, items } = req.body || {};
  const customerName = String(customer?.name || "").trim();
  const customerPhone = String(customer?.phone || "").trim();
  if (!customerName || !customerPhone || !Array.isArray(items) || !items.length || items.length > 100) {
    return res.status(400).json({ error: "بيانات الطلب ناقصة" });
  }
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    let subtotal = 0;
    let deliveryFee = 0;
    const normalizedItems = [];
    const requestedItems = new Map();
    const requestedStock = new Map();
    for (const item of items) {
        const productId = Number(item?.product_id);
        const quantity = Number(item?.quantity);
        const variantColor = item?.variant_color == null || item.variant_color === ""
          ? null
          : String(item.variant_color).toUpperCase();
        if (!Number.isInteger(productId) || productId < 1 || productId > 2147483647 ||
            !Number.isSafeInteger(quantity) || quantity < 1 ||
            (variantColor !== null && !/^#[0-9A-F]{6}$/.test(variantColor))) {
          throw new OrderValidationError("الكمية غير متوفرة: منتج");
        }
        const itemKey = `${productId}:${variantColor || ""}`;
        const combinedQuantity = (requestedItems.get(itemKey)?.quantity || 0) + quantity;
        if (!Number.isSafeInteger(combinedQuantity)) throw new OrderValidationError("الكمية غير متوفرة: منتج");
        requestedItems.set(itemKey, { productId, variantColor, quantity: combinedQuantity });
        const combinedStock = (requestedStock.get(productId) || 0) + quantity;
        if (!Number.isSafeInteger(combinedStock)) throw new OrderValidationError("الكمية غير متوفرة: منتج");
        requestedStock.set(productId, combinedStock);
    }
    const productsById = new Map();
    for (const [productId, quantity] of [...requestedStock].sort(([left], [right]) => left - right)) {
        const result = await client.query("SELECT * FROM products WHERE id = $1 AND active = TRUE FOR UPDATE", [productId]);
        const product = result.rows[0];
        if (!product || quantity > product.stock) {
          throw new OrderValidationError(`الكمية غير متوفرة: ${product?.name || "منتج"}`);
        }
        productsById.set(productId, product);
    }
    for (const item of requestedItems.values()) {
        const product = productsById.get(item.productId);
        const colors = Array.isArray(product.colors) ? product.colors : [];
        if ((colors.length && !colors.includes(item.variantColor)) || (!colors.length && item.variantColor)) {
          throw new OrderValidationError(`اللون غير متوفر: ${product.name}`);
        }
        const { quantity } = item;
        subtotal += Number(product.price) * quantity;
        deliveryFee = Math.max(deliveryFee, Number(product.delivery_price || 0));
        if (!Number.isFinite(subtotal) || subtotal > MAX_MONEY) {
          throw new OrderValidationError("المجموع يتجاوز الحد المسموح");
        }
        normalizedItems.push({ product, quantity, variantColor: item.variantColor });
    }
    if (subtotal >= FREE_SHIPPING_THRESHOLD) deliveryFee = 0;
    if (!Number.isFinite(subtotal + deliveryFee) || subtotal + deliveryFee > MAX_MONEY) {
      throw new OrderValidationError("المجموع يتجاوز الحد المسموح");
    }
    const total = subtotal + deliveryFee;
    const customerResult = await client.query(
      "INSERT INTO customers(name, phone, address, city) VALUES($1, $2, $3, $4) RETURNING id",
      [String(customer.name).trim(), String(customer.phone).trim(), String(customer.address || "").trim(), String(customer.city || "").trim()]
    );
    const orderResult = await client.query(
      `INSERT INTO orders(customer_id, total, delivery_fee, payment_method, inventory_deducted)
       VALUES($1, $2, $3, $4, FALSE) RETURNING id`,
      [customerResult.rows[0].id, total, deliveryFee, PAYMENT_METHOD]
    );
    const orderId = orderResult.rows[0].id;
    await client.query(
      `INSERT INTO order_status_history(order_id, to_status, changed_by)
       VALUES($1, 'new', 'customer')`,
      [orderId]
    );
    for (const item of normalizedItems) {
      await client.query(
        `INSERT INTO order_items(order_id, product_id, product_name, price, cost_price, delivery_price, quantity, variant_color)
         VALUES($1, $2, $3, $4, $5, $6, $7, $8)`,
        [orderId, item.product.id, item.product.name, item.product.price, item.product.cost_price,
          item.product.delivery_price || 0, item.quantity, item.variantColor]
      );
    }
    await client.query("COMMIT");
    publishAdminEvent("new-order", { order_id: orderId, total });
    res.json({
      order_id: orderId,
      subtotal,
      delivery_fee: deliveryFee,
      total,
      payment_method: PAYMENT_METHOD,
      items: normalizedItems.map(item => ({
        name: item.product.name,
        quantity: item.quantity,
        price: Number(item.product.price),
        variant_color: item.variantColor
      }))
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Could not roll back order:", rollbackError);
      }
    }
    if (error instanceof OrderValidationError) return res.status(400).json({ error: error.message });
    throw error;
  } finally {
    if (client) client.release();
  }
});

function publishAdminEvent(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of adminEventClients) {
    if (client.destroyed || client.writableEnded) {
      adminEventClients.delete(client);
      continue;
    }
    client.write(message);
  }
}

app.get("/api/orders", auth, async (req, res) => {
  const orders = await pool.query(
    `SELECT o.*, c.name AS customer_name, c.phone, c.address, c.city
     FROM orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.id DESC`
  );
  const items = await pool.query("SELECT * FROM order_items ORDER BY id");
  const itemsByOrder = new Map();
  for (const item of items.rows) {
    if (!itemsByOrder.has(item.order_id)) itemsByOrder.set(item.order_id, []);
    itemsByOrder.get(item.order_id).push(item);
  }
  res.json(orders.rows.map(order => ({ ...order, items: itemsByOrder.get(order.id) || [] })));
});
app.patch("/api/orders/:id/return-cost", auth, role("admin", "manager"), async (req, res) => {
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId) || orderId < 1 || orderId > 2147483647) {
    return res.status(400).json({ error: "رقم الطلب غير صالح" });
  }
  const returnCost = safeNum(req.body.return_cost, NaN);
  if (!Number.isFinite(returnCost) || returnCost < 0 || returnCost > MAX_MONEY) {
    return res.status(400).json({ error: "تكلفة الإرجاع غير صالحة" });
  }
  const result = await pool.query(
    `UPDATE orders
     SET return_cost = $1,
         return_cost_updated_at = CASE WHEN $1::numeric > 0 THEN CURRENT_TIMESTAMP ELSE NULL END
     WHERE id = $2 AND status = 'returned'
     RETURNING id`,
    [returnCost, orderId]
  );
  if (!result.rowCount) {
    const order = await pool.query("SELECT id FROM orders WHERE id = $1", [orderId]);
    if (!order.rowCount) return res.status(404).json({ error: "الطلب غير موجود" });
    return res.status(409).json({ error: "يمكن تسجيل تكلفة الإرجاع للطلب المرتجع فقط" });
  }
  res.json({ ok: true });
});
app.get("/api/orders/:id/history", auth, async (req, res) => {
  const result = await pool.query(
    `SELECT h.id, h.from_status, h.to_status, h.changed_by, h.created_at
     FROM order_status_history h
     WHERE h.order_id = $1
     ORDER BY h.created_at DESC, h.id DESC`,
    [req.params.id]
  );
  res.json(result.rows);
});
function normalizeRecipientPart(value) {
  return String(value || "").trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
app.post("/api/shipments", auth, role("admin", "manager"), async (req, res) => {
  if (!Array.isArray(req.body.order_ids) || req.body.order_ids.length < 2 || req.body.order_ids.length > 50) {
    return res.status(400).json({ error: "اختر طلبين على الأقل لإنشاء شحنة مجمعة" });
  }
  const orderIds = [...new Set(req.body.order_ids.map(Number))];
  if (orderIds.length !== req.body.order_ids.length || orderIds.some(id => !Number.isInteger(id) || id < 1 || id > 2147483647)) {
    return res.status(400).json({ error: "قائمة الطلبات غير صحيحة" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT o.id, o.status, o.shipment_id, o.total, c.name AS customer_name,
       c.phone, c.address, c.city
       FROM orders o JOIN customers c ON c.id = o.customer_id
       WHERE o.id = ANY($1::int[]) FOR UPDATE OF o`,
      [orderIds]
    );
    if (result.rowCount !== orderIds.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "تعذر العثور على جميع الطلبات المحددة" });
    }
    if (result.rows.some(order => !["new", "confirmed"].includes(order.status) || order.shipment_id)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "يمكن تجميع الطلبات الجديدة أو المؤكدة غير المشحونة فقط" });
    }
    const recipientKey = order => [
      String(order.phone || "").replace(/\D/g, ""),
      normalizeRecipientPart(order.address),
      normalizeRecipientPart(order.city)
    ].join("|");
    if (!recipientKey(result.rows[0]).split("|")[0] || result.rows.some(order => recipientKey(order) !== recipientKey(result.rows[0]))) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "يجب أن تكون الطلبات لنفس رقم الهاتف والعنوان" });
    }
    const items = await client.query(
      `SELECT COALESCE(SUM(delivery_price * quantity), 0) AS delivery_fee
       FROM order_items WHERE order_id = ANY($1::int[])`,
      [orderIds]
    );
    const deliveryFee = Number(items.rows[0].delivery_fee);
    const shipmentTotal = result.rows.reduce((sum, order) => sum + Number(order.total), 0);
    if (!Number.isFinite(deliveryFee) || !Number.isFinite(shipmentTotal) || shipmentTotal > MAX_MONEY) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "إجمالي الشحنة غير صالح" });
    }
    const firstOrder = result.rows[0];
    const shipment = await client.query(
      `INSERT INTO shipments(recipient_name, phone, address, city, delivery_fee, total)
       VALUES($1, $2, $3, $4, $5, $6) RETURNING id`,
      [firstOrder.customer_name, firstOrder.phone, firstOrder.address, firstOrder.city, deliveryFee, shipmentTotal]
    );
    const shipmentId = shipment.rows[0].id;
    await client.query(
      `INSERT INTO order_status_history(order_id, from_status, to_status, changed_by_id, changed_by)
       SELECT o.id, o.status, 'shipped', $2, $3
       FROM orders o WHERE o.id = ANY($1::int[])`,
      [orderIds, req.admin.id, req.admin.username]
    );
    await client.query(
      "UPDATE orders SET shipment_id = $1, status = 'shipped' WHERE id = ANY($2::int[])",
      [shipmentId, orderIds]
    );
    await client.query("COMMIT");
    res.status(201).json({ id: shipmentId, order_ids: orderIds, delivery_fee: deliveryFee, total: shipmentTotal });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Could not roll back shipment creation:", rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
});
app.get("/api/shipments", auth, async (req, res) => {
  const shipments = await pool.query(
    `SELECT s.*, COUNT(o.id)::int AS order_count,
     COUNT(o.id) FILTER (WHERE o.status = 'delivered')::int AS delivered_count,
     COALESCE(array_agg(o.id ORDER BY o.id) FILTER (WHERE o.id IS NOT NULL), ARRAY[]::int[]) AS order_ids
     FROM shipments s LEFT JOIN orders o ON o.shipment_id = s.id
     GROUP BY s.id ORDER BY s.id DESC`
  );
  res.json(shipments.rows);
});
app.delete("/api/shipments/:id", auth, role("admin", "manager"), async (req, res) => {
  const shipmentId = Number(req.params.id);
  if (!Number.isInteger(shipmentId) || shipmentId < 1 || shipmentId > 2147483647) {
    return res.status(400).json({ error: "رقم الشحنة غير صالح" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const shipment = await client.query(
      "SELECT id FROM shipments WHERE id = $1 FOR UPDATE",
      [shipmentId]
    );
    if (!shipment.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "الشحنة غير موجودة" });
    }
    const orders = await client.query(
      "SELECT id, status FROM orders WHERE shipment_id = $1 ORDER BY id FOR UPDATE",
      [shipmentId]
    );
    if (orders.rows.some(order => order.status === "delivered")) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "لا يمكن حذف شحنة تحتوي على طلبات مسلّمة" });
    }
    for (const order of orders.rows) {
      if (order.status !== "shipped") continue;
      const previousStatus = await client.query(
        `SELECT from_status FROM order_status_history
         WHERE order_id = $1 AND to_status = 'shipped' AND from_status IN ('new', 'confirmed')
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [order.id]
      );
      const restoredStatus = previousStatus.rows[0]?.from_status || "confirmed";
      await client.query(
        "UPDATE orders SET status = $1, shipment_id = NULL WHERE id = $2",
        [restoredStatus, order.id]
      );
      await client.query(
        `INSERT INTO order_status_history(order_id, from_status, to_status, changed_by_id, changed_by)
         VALUES($1, 'shipped', $2, $3, $4)`,
        [order.id, restoredStatus, req.admin.id, req.admin.username]
      );
    }
    await client.query("UPDATE orders SET shipment_id = NULL WHERE shipment_id = $1", [shipmentId]);
    await client.query("DELETE FROM shipments WHERE id = $1", [shipmentId]);
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Could not roll back shipment deletion:", rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
  res.json({ ok: true });
});
app.patch("/api/orders/:id/status", auth, role("admin", "manager"), async (req, res) => {
  const validStatuses = ["new", "confirmed", "shipped", "delivered", "cancelled", "returned"];
  if (!validStatuses.includes(req.body.status)) return res.status(400).json({ error: "حالة غير صحيحة" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      "SELECT status, inventory_deducted FROM orders WHERE id = $1 FOR UPDATE",
      [req.params.id]
    );
    if (!current.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "الطلب غير موجود" });
    }
    const { status: previousStatus, inventory_deducted: inventoryDeducted } = current.rows[0];
    if (previousStatus !== req.body.status) {
      if (previousStatus === "returned") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "لا يمكن تغيير حالة الطلب بعد تسجيله كمرتجع" });
      }
      if (req.body.status === "returned" && !["shipped", "delivered"].includes(previousStatus)) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "لا يمكن تسجيل الإرجاع إلا لطلب تم شحنه أو تسليمه" });
      }
      if (req.body.status === "confirmed" && !inventoryDeducted) {
        const items = await client.query(
          `SELECT product_id, product_name, quantity FROM order_items
           WHERE order_id = $1 ORDER BY product_id NULLS FIRST, id`,
          [req.params.id]
        );
        if (items.rows.some(item => item.product_id == null)) {
          throw new InventoryAvailabilityError("تعذر تأكيد الطلب: أحد المنتجات لم يعد موجوداً");
        }
        for (const item of items.rows) {
          const productResult = await client.query(
            "SELECT id, name, stock FROM products WHERE id = $1 FOR UPDATE",
            [item.product_id]
          );
          const product = productResult.rows[0];
          if (!product || Number(product.stock) < Number(item.quantity)) {
            throw new InventoryAvailabilityError(`لا توجد كمية كافية لتأكيد المنتج: ${item.product_name}`);
          }
          const stockBefore = Number(product.stock);
          const stockAfter = stockBefore - Number(item.quantity);
          await client.query("UPDATE products SET stock = $1 WHERE id = $2", [stockAfter, product.id]);
          await client.query(
            `INSERT INTO inventory_movements(product_id, product_name, movement_type, quantity_change, stock_before, stock_after, actor, order_id)
             VALUES($1, $2, 'sale', $3, $4, $5, $6, $7)`,
            [product.id, product.name, -Number(item.quantity), stockBefore, stockAfter, req.admin.username, req.params.id]
          );
        }
        await client.query("UPDATE orders SET inventory_deducted = TRUE WHERE id = $1", [req.params.id]);
      } else if (["cancelled", "returned"].includes(req.body.status) && inventoryDeducted) {
        const items = await client.query(
          `SELECT product_id, product_name, quantity FROM order_items
           WHERE order_id = $1 ORDER BY product_id NULLS FIRST, id`,
          [req.params.id]
        );
        for (const item of items.rows) {
          if (item.product_id == null) continue;
          const productResult = await client.query(
            "SELECT id, name, stock FROM products WHERE id = $1 FOR UPDATE",
            [item.product_id]
          );
          const product = productResult.rows[0];
          if (!product) continue;
          const stockBefore = Number(product.stock);
          const stockAfter = stockBefore + Number(item.quantity);
          await client.query("UPDATE products SET stock = $1 WHERE id = $2", [stockAfter, product.id]);
          await client.query(
            `INSERT INTO inventory_movements(product_id, product_name, movement_type, quantity_change, stock_before, stock_after, actor, order_id)
             VALUES($1, $2, 'return', $3, $4, $5, $6, $7)`,
            [product.id, product.name, Number(item.quantity), stockBefore, stockAfter, req.admin.username, req.params.id]
          );
        }
        await client.query("UPDATE orders SET inventory_deducted = FALSE WHERE id = $1", [req.params.id]);
      }
      await client.query("UPDATE orders SET status = $1 WHERE id = $2", [req.body.status, req.params.id]);
      await client.query(
        `INSERT INTO order_status_history(order_id, from_status, to_status, changed_by_id, changed_by)
         VALUES($1, $2, $3, $4, $5)`,
        [req.params.id, previousStatus, req.body.status, req.admin.id, req.admin.username]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Could not roll back order status update:", rollbackError);
    }
    if (error instanceof InventoryAvailabilityError) return res.status(409).json({ error: error.message });
    throw error;
  } finally {
    client.release();
  }
  res.json({ ok: true });
});
app.delete("/api/orders/:id", auth, role("admin", "manager"), async (req, res) => {
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId) || orderId < 1 || orderId > 2147483647) {
    return res.status(400).json({ error: "رقم الطلب غير صالح" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      "SELECT status, inventory_deducted, shipment_id FROM orders WHERE id = $1 FOR UPDATE",
      [orderId]
    );
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "الطلب غير موجود" });
    }
    const order = result.rows[0];
    if (["shipped", "delivered", "returned"].includes(order.status) || order.shipment_id) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "لا يمكن حذف طلب تم شحنه أو تسليمه" });
    }
    if (order.inventory_deducted) {
      const items = await client.query(
        `SELECT product_id, product_name, quantity FROM order_items
         WHERE order_id = $1 ORDER BY product_id NULLS FIRST, id`,
        [orderId]
      );
      for (const item of items.rows) {
        if (item.product_id == null) continue;
        const productResult = await client.query(
          "SELECT id, name, stock FROM products WHERE id = $1 FOR UPDATE",
          [item.product_id]
        );
        const product = productResult.rows[0];
        if (!product) continue;
        const stockBefore = Number(product.stock);
        const stockAfter = stockBefore + Number(item.quantity);
        await client.query("UPDATE products SET stock = $1 WHERE id = $2", [stockAfter, product.id]);
        await client.query(
          `INSERT INTO inventory_movements(product_id, product_name, movement_type, quantity_change, stock_before, stock_after, actor, order_id)
           VALUES($1, $2, 'return', $3, $4, $5, $6, $7)`,
          [product.id, product.name, Number(item.quantity), stockBefore, stockAfter, req.admin.username, orderId]
        );
      }
    }
    await client.query("DELETE FROM orders WHERE id = $1", [orderId]);
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Could not roll back order deletion:", rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
  res.json({ ok: true });
});
app.get("/api/customers", auth, async (req, res) => {
  const result = await pool.query(
    `SELECT c.*, COUNT(o.id)::int AS orders,
     COALESCE(SUM(CASE WHEN o.status NOT IN ('cancelled', 'returned') THEN o.total ELSE 0 END), 0) AS spent
     FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
     GROUP BY c.id ORDER BY c.id DESC`
  );
  res.json(result.rows);
});
app.get("/api/stats", auth, async (req, res) => {
  const [products, customers, orders, revenue, returnedQuantity, monthlyProfit, lowStock, ordersToday, ordersInDelivery, stock] = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS n FROM products WHERE active = TRUE"),
    pool.query("SELECT COUNT(*)::int AS n FROM customers"),
    pool.query("SELECT COUNT(*)::int AS n FROM orders"),
    pool.query("SELECT COALESCE(SUM(total), 0) AS n FROM orders WHERE status NOT IN ('cancelled', 'returned')"),
    pool.query(
      `SELECT COALESCE(SUM(oi.quantity), 0)::bigint AS n
       FROM order_status_history h
       JOIN order_items oi ON oi.order_id = h.order_id
       WHERE h.to_status = 'returned'
       AND h.created_at >= date_trunc('month', CURRENT_TIMESTAMP)`
    ),
    pool.query(
      `WITH return_expenses AS (
         SELECT COALESCE(SUM(return_cost), 0) AS amount
         FROM orders
         WHERE status = 'returned'
         AND return_cost_updated_at >= date_trunc('month', CURRENT_TIMESTAMP)
       ),
       product_margins AS (
         SELECT SUM((oi.price - oi.cost_price) * oi.quantity) AS amount,
         COUNT(oi.cost_price) AS costed_items,
         COUNT(*) FILTER (WHERE oi.cost_price IS NULL)::int AS uncosted_items
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
         WHERE o.status NOT IN ('cancelled', 'returned')
         AND o.created_at >= date_trunc('month', CURRENT_TIMESTAMP)
       )
       SELECT CASE
         WHEN product_margins.costed_items > 0 OR return_expenses.amount > 0
         THEN COALESCE(product_margins.amount, 0) - return_expenses.amount
         ELSE NULL
       END AS n,
       product_margins.uncosted_items
       FROM product_margins CROSS JOIN return_expenses`
    ),
    pool.query(
      "SELECT COUNT(*)::int AS n FROM products WHERE active = TRUE AND stock BETWEEN 1 AND $1",
      [LOW_STOCK_THRESHOLD]
    ),
    pool.query(
      "SELECT COUNT(*)::int AS n FROM orders WHERE status = 'new' AND created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'"
    ),
    pool.query(
      "SELECT COUNT(*)::int AS n FROM orders WHERE status = 'shipped'"
    ),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE active = TRUE)::int AS total_products,
       COUNT(*) FILTER (WHERE active = TRUE AND stock > $1)::int AS available,
       COUNT(*) FILTER (WHERE active = TRUE AND stock BETWEEN 1 AND $1)::int AS low_stock,
       COUNT(*) FILTER (WHERE active = TRUE AND stock = 0)::int AS out_of_stock
       FROM products`,
      [LOW_STOCK_THRESHOLD]
    )
  ]);
  res.json({
    products: products.rows[0].n,
    customers: customers.rows[0].n,
    orders: orders.rows[0].n,
    revenue: revenue.rows[0].n,
    monthlyReturnedQuantity: returnedQuantity.rows[0].n,
    monthlyGrossProfit: monthlyProfit.rows[0].n,
    monthlyUncostedItems: monthlyProfit.rows[0].uncosted_items,
    lowStockProducts: lowStock.rows[0].n,
    ordersNewToday: ordersToday.rows[0].n,
    ordersInDelivery: ordersInDelivery.rows[0].n,
    stockSummary: stock.rows[0],
    lowStockThreshold: LOW_STOCK_THRESHOLD
  });
});

app.get("/api/orders/:id/invoice", auth, async (req, res) => {
  const result = await pool.query(
    `SELECT o.*, c.name AS customer_name, c.phone, c.address, c.city
     FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1`,
    [req.params.id]
  );
  const order = result.rows[0];
  if (!order) return res.status(404).json({ error: "الطلب غير موجود" });
  const items = await pool.query("SELECT * FROM order_items WHERE order_id = $1 ORDER BY id", [order.id]);
  const subtotal = items.rows.reduce((sum, item) => sum + Number(item.price) * Number(item.quantity), 0);
  const deliveryFee = Number(order.delivery_fee || 0);
  const createdAt = new Date(order.created_at).toLocaleDateString("fr-FR", {
    dateStyle: "medium"
  });
  const invoiceNumber = `${new Date(order.created_at).getFullYear()}-${String(order.id).padStart(3, "0")}`;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename=invoice-${order.id}.pdf`);

  const document = new PDFDocument({ size: "A4", margin: 44, bufferPages: true });
  document.pipe(res);

  const accent = "#c99a3b";
  const deep = "#172554";
  const invoiceBrand = "MA-DOR";
  const text = "#1f2937";
  const soft = "#f5f7fb";
  const border = "#e5e7eb";
  const pageWidth = document.page.width;
  const pageHeight = document.page.height;
  const left = 44;
  const right = pageWidth - 44;
  const contentWidth = right - left;
  const footerY = pageHeight - 58;
  const columns = {
    product: { x: left + 14, width: 224 },
    quantity: { x: left + 260, width: 46 },
    unitPrice: { x: left + 316, width: 92 },
    total: { x: left + 414, width: 79 }
  };
  const formatMoney = value => `${Number(value).toFixed(3).replace(".", ",")} ${CURRENCY}`;

  function drawTableHeader(y) {
    document.fillColor(soft).roundedRect(left, y, contentWidth, 34, 8).fill();
    document.fillColor(deep).font("Helvetica-Bold").fontSize(8)
      .text("PRODUIT", columns.product.x, y + 12, { width: columns.product.width });
    document.text("QTÉ", columns.quantity.x, y + 12, { width: columns.quantity.width, align: "center" });
    document.text("PRIX UNIT.", columns.unitPrice.x, y + 12, { width: columns.unitPrice.width, align: "right" });
    document.text("TOTAL", columns.total.x, y + 12, { width: columns.total.width, align: "right" });
    return y + 42;
  }

  function drawPageHeader(firstPage) {
    if (firstPage) {
      document.fillColor(deep).rect(0, 0, pageWidth, 138).fill();
      document.fillColor(accent).rect(0, 0, 6, 138).fill();
      document.fillColor(accent).font("Times-Bold").fontSize(30)
        .text(invoiceBrand, left, 30, { width: 300, lineBreak: false });
      document.fillColor("#dbe3f4").font("Helvetica").fontSize(8)
        .text("VOTRE BOUTIQUE, EN TOUTE CONFIANCE", left + 2, 70, { width: 280, lineBreak: false, characterSpacing: 0.6 });
      document.fillColor("#dbe3f4").font("Helvetica").fontSize(7.5)
        .text("Adresse : Avenue des Martyrs, Manouba", left + 2, 83, { width: 340, lineBreak: false });
      document.text("Téléphone : 27326608", left + 2, 94, { width: 340, lineBreak: false });
      document.text("E-mail : contact@mador.tn", left + 2, 105, { width: 340, lineBreak: false });
      document.text("Site web : https://mador.tn", left + 2, 116, { width: 340, lineBreak: false });
      document.fillColor("#dbe3f4").font("Helvetica-Bold").fontSize(8)
        .text("FACTURE N°", right - 132, 27, { width: 132, align: "right", characterSpacing: 1.2 });
      document.fillColor("#ffffff").font("Helvetica-Bold").fontSize(24)
        .text(invoiceNumber, right - 132, 47, { width: 132, align: "right" });
      document.fillColor("#dbe3f4").font("Helvetica").fontSize(9)
        .text(createdAt, right - 132, 82, { width: 132, align: "right" });

      const infoY = 150;
      const cardWidth = (contentWidth - 14) / 2;
      document.roundedRect(left, infoY, cardWidth, 112, 10).fillAndStroke("#ffffff", border);
      document.roundedRect(left + cardWidth + 14, infoY, cardWidth, 112, 10).fillAndStroke("#ffffff", border);

      document.fillColor(accent).font("Helvetica-Bold").fontSize(8)
        .text("FACTURÉ À", left + 15, infoY + 14, { width: cardWidth - 30, characterSpacing: 0.8 });
      document.fillColor(text).font("Helvetica-Bold").fontSize(12)
        .text(String(order.customer_name || "-"), left + 15, infoY + 34, { width: cardWidth - 30, height: 18, ellipsis: true });
      document.fillColor("#596579").font("Helvetica").fontSize(9)
        .text(`Téléphone : ${order.phone || "-"}`, left + 15, infoY + 59, { width: cardWidth - 30, height: 14, ellipsis: true });
      document.text(`Adresse : ${[order.address, order.city].filter(Boolean).join(", ") || "-"}`,
        left + 15, infoY + 78, { width: cardWidth - 30, height: 24, ellipsis: true });

      const detailX = left + cardWidth + 29;
      document.fillColor(accent).font("Helvetica-Bold").fontSize(8)
        .text("DÉTAILS DE LA FACTURE", detailX, infoY + 14, { width: cardWidth - 30, characterSpacing: 0.5 });
      document.fillColor("#596579").font("Helvetica").fontSize(9)
        .text(`Date : ${createdAt}`, detailX, infoY + 39, { width: cardWidth - 30 });
      document.text("Paiement : à la livraison", detailX, infoY + 61, { width: cardWidth - 30 });
      document.fillColor("#15805d").font("Helvetica-Bold").fontSize(8)
        .text("MERCI POUR VOTRE COMMANDE", detailX, infoY + 84, { width: cardWidth - 30 });
      return drawTableHeader(282);
    }

    document.fillColor(deep).rect(0, 0, pageWidth, 62).fill();
    document.fillColor(accent).rect(0, 0, 6, 62).fill();
    document.fillColor("#d1a43b").font("Times-Bold").fontSize(19)
      .text(invoiceBrand, left, 17, { width: 300, lineBreak: false });
    document.fillColor("#dbe3f4").font("Helvetica-Bold").fontSize(9)
      .text(`FACTURE N° ${invoiceNumber}`, right - 180, 25, { width: 180, align: "right" });
    return drawTableHeader(82);
  }

  let y = drawPageHeader(true);
  let rowIndex = 0;
  for (const item of items.rows) {
    const productName = String(item.product_name || "Produit");
    const variantColor = normalizeColorHex(item.variant_color);
    const variantLabel = variantColor ? `Couleur : ${colorName(variantColor, "fr")}` : "";
    const productOptions = { width: columns.product.width, font: "Helvetica", fontSize: 9 };
    const productHeight = document.heightOfString(productName, productOptions);
    const rowHeight = Math.max(variantLabel ? 45 : 40, productHeight + (variantLabel ? 28 : 18));
    if (y + rowHeight + 132 > footerY) {
      document.addPage();
      y = drawPageHeader(false);
    }
    if (rowIndex % 2 === 0) {
      document.fillColor("#fafbfd").roundedRect(left, y, contentWidth, rowHeight, 6).fill();
    }
    document.fillColor(text).font("Helvetica").fontSize(9)
      .text(productName, columns.product.x, y + (variantLabel ? 7 : 12), { width: columns.product.width, height: rowHeight - 18, ellipsis: true });
    if (variantLabel) {
      document.fillColor(variantColor).circle(columns.product.x + 3, y + 31, 3).fill();
      document.fillColor("#4b5563").font("Helvetica").fontSize(8)
        .text(variantLabel, columns.product.x + 11, y + 25, { width: columns.product.width - 11, height: 12, ellipsis: true });
    }
    const textY = y + Math.max(12, (rowHeight - 10) / 2);
    document.fillColor(soft).roundedRect(columns.quantity.x + 7, textY - 5, 32, 21, 7).fill();
    document.fillColor(text).font("Helvetica-Bold").fontSize(9)
      .text(String(item.quantity || 0), columns.quantity.x + 7, textY, { width: 32, align: "center" });
    document.fillColor("#596579").font("Helvetica").fontSize(9)
      .text(formatMoney(item.price), columns.unitPrice.x, textY, { width: columns.unitPrice.width, align: "right" });
    document.fillColor(text).font("Helvetica-Bold").fontSize(9).text(
      formatMoney(Number(item.price) * Number(item.quantity)),
      columns.total.x, textY, { width: columns.total.width, align: "right" }
    );
    document.strokeColor(border).lineWidth(0.45).moveTo(left + 8, y + rowHeight + 2).lineTo(right - 8, y + rowHeight + 2).stroke();
    y += rowHeight + 4;
    rowIndex += 1;
  }

  if (y + 132 > footerY) {
    document.addPage();
    y = drawPageHeader(false);
  }
  const totalsY = y + 12;
  const totalsX = right - 250;
  const stampX = left + 64;
  const stampY = totalsY + 56;
  document.circle(stampX, stampY, 49).fillAndStroke("#fffaf0", accent);
  document.lineWidth(1.2).circle(stampX, stampY, 43).strokeColor(deep).stroke();
  document.lineWidth(0.7).circle(stampX, stampY, 39).strokeColor(accent).stroke();
  document.fillColor(accent).font("Helvetica-Bold").fontSize(7.5)
    .text("MERCI", stampX - 37, stampY - 30, { width: 74, align: "center", lineBreak: false, characterSpacing: 1 });
  document.fillColor(deep).font("Times-Bold").fontSize(20)
    .text("M&D", stampX - 38, stampY - 15, { width: 76, align: "center", lineBreak: false });
  document.strokeColor(accent).lineWidth(0.8).moveTo(stampX - 22, stampY + 9).lineTo(stampX + 22, stampY + 9).stroke();
  document.fillColor(deep).font("Helvetica-Bold").fontSize(7.5)
    .text("MA-DOR", stampX - 35, stampY + 13, { width: 70, align: "center", lineBreak: false, characterSpacing: 1 });
  document.fillColor("#596579").font("Helvetica").fontSize(5.5)
    .text("BOUTIQUE  -  TUNISIE", stampX - 37, stampY + 25, { width: 74, align: "center", lineBreak: false, characterSpacing: 0.2 });
  for (const offset of [-31, 31]) {
    document.fillColor(accent).circle(stampX + offset, stampY + 1, 1.5).fill();
  }
  document.roundedRect(totalsX, totalsY, 250, 112, 10).fillAndStroke("#ffffff", border);
  document.fillColor("#596579").font("Helvetica").fontSize(9).text("Sous-total", totalsX + 15, totalsY + 15);
  document.fillColor(text).font("Helvetica-Bold").text(formatMoney(subtotal), totalsX + 110, totalsY + 15, { width: 124, align: "right" });
  document.fillColor("#596579").font("Helvetica").text("Livraison", totalsX + 15, totalsY + 37);
  document.fillColor(text).font("Helvetica-Bold").text(formatMoney(deliveryFee), totalsX + 110, totalsY + 37, { width: 124, align: "right" });
  document.strokeColor(border).lineWidth(0.8).moveTo(totalsX + 15, totalsY + 61).lineTo(totalsX + 235, totalsY + 61).stroke();
  document.fillColor(deep).font("Helvetica-Bold").fontSize(10).text("TOTAL", totalsX + 15, totalsY + 82);
  document.fillColor(accent).fontSize(14).text(formatMoney(order.total),
    totalsX + 105, totalsY + 78, { width: 129, align: "right" });

  const pageRange = document.bufferedPageRange();
  for (let page = pageRange.start; page < pageRange.start + pageRange.count; page += 1) {
    document.switchToPage(page);
    document.strokeColor(border).lineWidth(0.8).moveTo(left, footerY).lineTo(right, footerY).stroke();
    document.fillColor("#6b7280").font("Helvetica").fontSize(8)
      .text("Merci pour votre confiance.", left, footerY + 2, { width: contentWidth, align: "center" });
    document.fillColor("#9ca3af").fontSize(8)
      .text(`${page + 1} / ${pageRange.count}`, left, footerY + 2, { width: contentWidth, align: "right" });
  }
  document.end();
});

app.get("/api/admins", auth, role("admin"), async (req, res) => {
  const result = await pool.query("SELECT id, username, role FROM admins ORDER BY id");
  res.json(result.rows);
});
app.get("/api/admin/audit", auth, role("admin"), async (req, res) => {
  const result = await pool.query(
    `SELECT id, admin_username, method, endpoint, created_at
     FROM admin_audit_logs
     ORDER BY created_at DESC, id DESC
     LIMIT 500`
  );
  res.json(result.rows);
});
app.get("/api/admin/project-docs/:document", auth, async (req, res) => {
  const documents = {
    history: "HISTORY.md",
    presentation: "PROJECT-PRESENTATION.md"
  };
  const fileName = documents[req.params.document];
  if (!fileName) return res.status(404).json({ error: "Document introuvable" });
  const content = await fs.promises.readFile(path.join(__dirname, fileName), "utf8");
  res.type("text/plain").send(content);
});
app.post("/api/admins", auth, role("admin"), async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  if (!username || password.length < 6) {
    return res.status(400).json({ error: "اسم المستخدم وكلمة مرور من 6 أحرف على الأقل مطلوبان" });
  }
  try {
    const passwordHash = bcrypt.hashSync(password, 12);
    const result = await pool.query(
      "INSERT INTO admins(username, password_hash, role) VALUES($1, $2, $3) RETURNING id",
      [username, passwordHash, req.body.role === "manager" ? "manager" : "admin"]
    );
    res.json({ id: result.rows[0].id });
  } catch (error) {
    if (error.code === "23505") return res.status(400).json({ error: "اسم المستخدم موجود" });
    throw error;
  }
});
app.delete("/api/admins/:id", auth, role("admin"), async (req, res) => {
  if (Number(req.params.id) === Number(req.admin.id)) return res.status(400).json({ error: "لا يمكن حذف المستخدم الحالي" });
  await pool.query("DELETE FROM admins WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public/admin/index.html")));
app.get("/health", async (req, res) => {
  await pool.query("SELECT 1");
  res.json({ status: "ok" });
});
app.use("/api", (req, res) => res.status(404).json({ error: "Route API introuvable" }));
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return res.status(404).json({ error: "Route introuvable" });
  res.sendFile(path.join(__dirname, "public/index.html"), error => error && next(error));
});
app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  const status = error.statusCode || error.status ||
    (error instanceof multer.MulterError ? error.code === "LIMIT_FILE_SIZE" ? 413 : 400 : 500);
  res.status(status).json({ error: status >= 500 ? "Erreur serveur" : error.message });
});

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin'
    );
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      icon TEXT NOT NULL DEFAULT 'tag',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER,
      parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL
    );
    ALTER TABLE categories ADD COLUMN IF NOT EXISTS icon TEXT NOT NULL DEFAULT 'tag';
    ALTER TABLE categories ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE categories ADD COLUMN IF NOT EXISTS sort_order INTEGER;
    ALTER TABLE categories ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL;
    UPDATE categories AS c SET sort_order = ordered.position - 1
      FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY name, id) AS position
            FROM categories WHERE sort_order IS NULL) AS ordered
      WHERE c.id = ordered.id;
    ALTER TABLE categories ALTER COLUMN sort_order SET DEFAULT 0;
    ALTER TABLE categories ALTER COLUMN sort_order SET NOT NULL;
    CREATE INDEX IF NOT EXISTS categories_sort_order_idx ON categories(sort_order, id);
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      price NUMERIC(12, 2) NOT NULL,
      cost_price NUMERIC(12, 2),
      delivery_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
      old_price NUMERIC(12, 2),
      stock INTEGER NOT NULL DEFAULT 0,
      colors TEXT[] NOT NULL DEFAULT '{}',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      advertised BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE products ADD COLUMN IF NOT EXISTS advertised BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS delivery_price NUMERIC(12, 2) NOT NULL DEFAULT 0;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_price NUMERIC(12, 2);
    ALTER TABLE products ADD COLUMN IF NOT EXISTS sort_order INTEGER;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS colors TEXT[] NOT NULL DEFAULT '{}';
    UPDATE products SET colors = '{}' WHERE colors IS NULL;
    ALTER TABLE products ALTER COLUMN colors SET DEFAULT '{}';
    ALTER TABLE products ALTER COLUMN colors SET NOT NULL;
    CREATE INDEX IF NOT EXISTS products_sort_order_idx ON products(sort_order, id)
      WHERE sort_order IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS products_single_advertised_idx
      ON products (advertised) WHERE advertised = TRUE AND active = TRUE;
    CREATE TABLE IF NOT EXISTS product_images (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      path TEXT NOT NULL
    );
    ALTER TABLE product_images ADD COLUMN IF NOT EXISTS image_data BYTEA;
    ALTER TABLE product_images ADD COLUMN IF NOT EXISTS content_type TEXT;
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      total NUMERIC(12, 2) NOT NULL,
      delivery_fee NUMERIC(12, 2) NOT NULL DEFAULT 0,
      payment_method TEXT NOT NULL DEFAULT 'cash_on_delivery',
      status TEXT NOT NULL DEFAULT 'new',
      return_cost NUMERIC(12, 2) NOT NULL DEFAULT 0,
      return_cost_updated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC(12, 2) NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'cash_on_delivery';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS return_cost NUMERIC(12, 2) NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS return_cost_updated_at TIMESTAMPTZ;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS inventory_deducted BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE orders ALTER COLUMN inventory_deducted SET DEFAULT FALSE;
    CREATE TABLE IF NOT EXISTS shipments (
      id SERIAL PRIMARY KEY,
      recipient_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      delivery_fee NUMERIC(12, 2) NOT NULL DEFAULT 0,
      total NUMERIC(12, 2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipment_id INTEGER REFERENCES shipments(id) ON DELETE SET NULL;
    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      product_name TEXT NOT NULL,
      price NUMERIC(12, 2) NOT NULL,
      cost_price NUMERIC(12, 2),
      delivery_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
      quantity INTEGER NOT NULL,
      variant_color TEXT
    );
    ALTER TABLE order_items ADD COLUMN IF NOT EXISTS delivery_price NUMERIC(12, 2) NOT NULL DEFAULT 0;
    ALTER TABLE order_items ADD COLUMN IF NOT EXISTS cost_price NUMERIC(12, 2);
    ALTER TABLE order_items ADD COLUMN IF NOT EXISTS variant_color TEXT;
    CREATE TABLE IF NOT EXISTS inventory_movements (
      id SERIAL PRIMARY KEY,
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      product_name TEXT NOT NULL,
      movement_type TEXT NOT NULL CHECK (movement_type IN ('initial', 'restock', 'adjustment', 'sale', 'return')),
      quantity_change INTEGER NOT NULL,
      stock_before INTEGER NOT NULL,
      stock_after INTEGER NOT NULL,
      actor TEXT NOT NULL,
      order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE inventory_movements DROP CONSTRAINT IF EXISTS inventory_movements_movement_type_check;
    ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_movement_type_check
      CHECK (movement_type IN ('initial', 'restock', 'adjustment', 'sale', 'return'));
    CREATE INDEX IF NOT EXISTS inventory_movements_created_at_idx
      ON inventory_movements(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS inventory_movements_product_id_idx
      ON inventory_movements(product_id, created_at DESC);
    INSERT INTO inventory_movements(product_id, product_name, movement_type, quantity_change, stock_before, stock_after, actor)
    SELECT p.id, p.name, 'initial', p.stock, 0, p.stock, 'system'
    FROM products p
    WHERE p.stock > 0
      AND NOT EXISTS (
        SELECT 1 FROM inventory_movements m WHERE m.product_id = p.id
      );
    CREATE TABLE IF NOT EXISTS order_status_history (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      from_status TEXT,
      to_status TEXT NOT NULL,
      changed_by_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
      changed_by TEXT NOT NULL DEFAULT 'system',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO order_status_history(order_id, from_status, to_status, changed_by)
    SELECT o.id, NULL, o.status, 'system'
    FROM orders o
    WHERE NOT EXISTS (
      SELECT 1 FROM order_status_history h WHERE h.order_id = o.id
    );
    CREATE INDEX IF NOT EXISTS order_status_history_order_id_idx
      ON order_status_history(order_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id SERIAL PRIMARY KEY,
      admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
      admin_username TEXT NOT NULL,
      method TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS admin_audit_logs_created_at_idx
      ON admin_audit_logs(created_at DESC);
    CREATE TABLE IF NOT EXISTS store_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS store_assets (
      asset_key TEXT PRIMARY KEY,
      image_data BYTEA NOT NULL,
      content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif')),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS store_navigation_links (
      id SERIAL PRIMARY KEY,
      label_ar TEXT NOT NULL,
      label_fr TEXT NOT NULL,
      href TEXT NOT NULL,
      position INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS category_icon_options (
      id TEXT PRIMARY KEY,
      label_ar TEXT NOT NULL,
      label_fr TEXT NOT NULL,
      icon_type TEXT NOT NULL CHECK (icon_type IN ('tag', 'clothing', 'bag', 'watch', 'accessory')),
      position INTEGER NOT NULL
    );
  `);
  await pool.query(
    `WITH initialized AS (
       INSERT INTO store_settings(key, value) VALUES('category_icon_options_initialized', '1')
       ON CONFLICT (key) DO NOTHING
       RETURNING key
     )
     INSERT INTO category_icon_options(id, label_ar, label_fr, icon_type, position)
     SELECT icon_option.id, icon_option.label_ar, icon_option.label_fr, icon_option.icon_type, icon_option.position
     FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::integer[])
       AS icon_option(id, label_ar, label_fr, icon_type, position)
     WHERE EXISTS (SELECT 1 FROM initialized)`,
    [
      DEFAULT_CATEGORY_ICON_OPTIONS.map(option => option.id),
      DEFAULT_CATEGORY_ICON_OPTIONS.map(option => option.label_ar),
      DEFAULT_CATEGORY_ICON_OPTIONS.map(option => option.label_fr),
      DEFAULT_CATEGORY_ICON_OPTIONS.map(option => option.icon_type),
      DEFAULT_CATEGORY_ICON_OPTIONS.map((option, index) => index)
    ]
  );
  await pool.query(
    `DO $$
     BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint WHERE conname = 'categories_icon_option_fk'
       ) THEN
         ALTER TABLE categories
           ADD CONSTRAINT categories_icon_option_fk
           FOREIGN KEY (icon) REFERENCES category_icon_options(id);
       END IF;
     END $$`
  );
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM store_settings WHERE key = 'category_hierarchy_migrated') THEN
        IF EXISTS (SELECT 1 FROM categories WHERE name IN ('Électronique', 'Electronique'))
           AND NOT EXISTS (SELECT 1 FROM categories WHERE name = 'Ordinateurs') THEN
          UPDATE categories SET name = 'Ordinateurs'
          WHERE name IN ('Électronique', 'Electronique');
        END IF;
        INSERT INTO categories(name, icon, active, sort_order)
        SELECT seed.name, 'tag', TRUE, seed.sort_order
        FROM (VALUES
          ('High-Tech', 0),
          ('Audio & Casques', 1),
          ('Smartphones', 2),
          ('Ordinateurs', 3),
          ('Objets connectés', 4),
          ('Mode', 5),
          ('Sacs & Maroquinerie', 6),
          ('Chaussures', 7),
          ('Montres', 8),
          ('Lunettes', 9),
          ('Maison', 10),
          ('Décoration', 11),
          ('Luminaires', 12),
          ('Cuisine', 13),
          ('Beauté', 14),
          ('Parfums', 15),
          ('Soins', 16),
          ('Sport', 17),
          ('Fitness', 18),
          ('Outdoor', 19),
          ('Accessoires', 20),
          ('Automobile', 21),
          ('Bagagerie', 22),
          ('Petite maroquinerie', 23)
        ) AS seed(name, sort_order)
        ON CONFLICT (name) DO NOTHING;
        UPDATE categories AS child SET parent_id = parent.id
        FROM (VALUES
          ('Audio & Casques', 'High-Tech'),
          ('Smartphones', 'High-Tech'),
          ('Ordinateurs', 'High-Tech'),
          ('Objets connectés', 'High-Tech'),
          ('Sacs & Maroquinerie', 'Mode'),
          ('Chaussures', 'Mode'),
          ('Montres', 'Mode'),
          ('Lunettes', 'Mode'),
          ('Décoration', 'Maison'),
          ('Luminaires', 'Maison'),
          ('Cuisine', 'Maison'),
          ('Parfums', 'Beauté'),
          ('Soins', 'Beauté'),
          ('Fitness', 'Sport'),
          ('Outdoor', 'Sport'),
          ('Automobile', 'Accessoires'),
          ('Bagagerie', 'Accessoires'),
          ('Petite maroquinerie', 'Accessoires')
        ) AS seed(child_name, parent_name)
        JOIN categories parent ON parent.name = seed.parent_name
        WHERE child.name = seed.child_name;
        UPDATE categories AS category SET parent_id = NULL
        WHERE category.name IN ('High-Tech', 'Mode', 'Maison', 'Beauté', 'Sport', 'Accessoires');
        UPDATE categories SET sort_order = CASE name
          WHEN 'High-Tech' THEN 0
          WHEN 'Audio & Casques' THEN 1
          WHEN 'Smartphones' THEN 2
          WHEN 'Ordinateurs' THEN 3
          WHEN 'Objets connectés' THEN 4
          WHEN 'Mode' THEN 5
          WHEN 'Sacs & Maroquinerie' THEN 6
          WHEN 'Chaussures' THEN 7
          WHEN 'Montres' THEN 8
          WHEN 'Lunettes' THEN 9
          WHEN 'Maison' THEN 10
          WHEN 'Décoration' THEN 11
          WHEN 'Luminaires' THEN 12
          WHEN 'Cuisine' THEN 13
          WHEN 'Beauté' THEN 14
          WHEN 'Parfums' THEN 15
          WHEN 'Soins' THEN 16
          WHEN 'Sport' THEN 17
          WHEN 'Fitness' THEN 18
          WHEN 'Outdoor' THEN 19
          WHEN 'Accessoires' THEN 20
          WHEN 'Automobile' THEN 21
          WHEN 'Bagagerie' THEN 22
          WHEN 'Petite maroquinerie' THEN 23
          ELSE 100 + sort_order
        END;
        INSERT INTO store_settings(key, value) VALUES('category_hierarchy_migrated', '1');
      END IF;
    END $$;
  `);
  await pool.query(
    `WITH initialized AS (
       INSERT INTO store_settings(key, value) VALUES('navigation_links_initialized', '1')
       ON CONFLICT (key) DO NOTHING
       RETURNING key
     )
     INSERT INTO store_navigation_links(label_ar, label_fr, href, position)
     SELECT label_ar, label_fr, href, ordinal - 1
     FROM UNNEST($1::text[], $2::text[], $3::text[]) WITH ORDINALITY
       AS link(label_ar, label_fr, href, ordinal)
     WHERE EXISTS (SELECT 1 FROM initialized)
       AND NOT EXISTS (SELECT 1 FROM store_navigation_links)`,
    [
      DEFAULT_NAVIGATION_LINKS.map(link => link.label_ar),
      DEFAULT_NAVIGATION_LINKS.map(link => link.label_fr),
      DEFAULT_NAVIGATION_LINKS.map(link => link.href)
    ]
  );
  await pool.query(
    `INSERT INTO store_settings(key, value) VALUES
       ('whatsapp', $1),
       ('contact_phone', ''),
       ('contact_email', ''),
       ('contact_address', ''),
       ('opening_hours', ''),
       ('social_facebook', ''),
       ('social_instagram', ''),
       ('social_tiktok', ''),
       ('hero_background_url', ''),
       ('hero_logo_url', ''),
       ('hero_card_x', '0'),
       ('hero_card_y', '0'),
       ('hero_overlay', '15'),
       ('hero_price_size', '29'),
       ('product_columns', '4'),
       ('category_columns', '4')
     ON CONFLICT (key) DO NOTHING`,
    [WHATSAPP_CONFIGURED ? WA : ""]
  );
  await pool.query(
    `WITH migration AS (
       INSERT INTO store_settings(key, value) VALUES('hero_background_image_migrated', '1')
       ON CONFLICT (key) DO NOTHING
       RETURNING key
     )
     UPDATE store_settings SET value = '/hero-background.png'
     WHERE key = 'hero_background_url'
       AND EXISTS (SELECT 1 FROM migration)`
  );
  await migrateLegacyHeroBackground();
  await pool.query(
    `WITH migration AS (
       INSERT INTO store_settings(key, value) VALUES('hero_overlay_visibility_migrated', '1')
       ON CONFLICT (key) DO NOTHING
       RETURNING key
     )
     UPDATE store_settings SET value = '15'
     WHERE key = 'hero_overlay' AND value = '35'
       AND EXISTS (SELECT 1 FROM migration)`
  );
  const passwordHash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || "Admin@12345", 12);
  await pool.query(
    `INSERT INTO admins(username, password_hash, role)
     SELECT $1, $2, 'admin' WHERE NOT EXISTS (SELECT 1 FROM admins)
     ON CONFLICT (username) DO NOTHING`,
    [process.env.ADMIN_USER || "admin", passwordHash]
  );
  await migrateLegacyProductImages();
}

initializeDatabase()
  .then(() => app.listen(PORT, () => console.log(`${STORE}: http://localhost:${PORT}`)))
  .catch(error => {
    console.error("Could not initialize PostgreSQL:", error.message);
    process.exitCode = 1;
    pool.end();
  });