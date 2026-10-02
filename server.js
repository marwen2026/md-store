require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const PDFDocument = require("pdfkit");

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
app.use("/uploads", express.static(uploadDir));
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
  const deliveryPrice = body.delivery_price === "" || body.delivery_price == null ? 0 : safeNum(body.delivery_price, NaN);
  const oldPrice = body.old_price === "" || body.old_price == null ? null : safeNum(body.old_price, NaN);
  const stock = safeNum(body.stock, 0);
  const categoryValue = String(body.category_id || "").trim();
  const categoryId = categoryValue ? Number(categoryValue) : null;
    if (!name || !Number.isFinite(price) || price < 0 || price > MAX_MONEY ||
      !Number.isFinite(deliveryPrice) || deliveryPrice < 0 || deliveryPrice > MAX_MONEY ||
      (oldPrice !== null && (!Number.isFinite(oldPrice) || oldPrice < 0 || oldPrice > MAX_MONEY)) ||
      !Number.isInteger(stock) || stock < 0 || stock > 2147483647 ||
      (categoryId !== null && (!Number.isInteger(categoryId) || categoryId < 1 || categoryId > 2147483647))) {
    return null;
  }
  return {
    name,
    description: String(body.description || ""),
    categoryId,
    price,
    deliveryPrice,
    oldPrice,
    stock,
    advertised: ["1", "true", "on"].includes(String(body.advertised).toLowerCase()),
    active: body.active === undefined || ["1", "true", "on"].includes(String(body.active).toLowerCase())
  };
}

function removeUploadedFiles(files = []) {
  for (const file of files) {
    try {
      fs.unlinkSync(file.path);
    } catch (error) {
      if (error.code !== "ENOENT") console.error("Could not remove uploaded image:", error);
    }
  }
}

class OrderValidationError extends Error {}
class InventoryAvailabilityError extends Error {}

async function productRows(includeInactive = false) {
  const products = await pool.query(
    `SELECT p.*, c.name AS category_name
     FROM products p LEFT JOIN categories c ON c.id = p.category_id
     ${includeInactive ? "" : "WHERE p.active = TRUE AND (p.category_id IS NULL OR c.active = TRUE)"}
     ORDER BY p.id DESC`
  );
  const images = await pool.query("SELECT id, product_id, path FROM product_images ORDER BY id");
  const imagesByProduct = new Map();
  for (const image of images.rows) {
    if (!imagesByProduct.has(image.product_id)) imagesByProduct.set(image.product_id, []);
    imagesByProduct.get(image.product_id).push({ id: image.id, path: image.path });
  }
  return products.rows.map(product => ({
    ...product,
    images: imagesByProduct.get(product.id) || []
  }));
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

function whatsappIsConfigured(value) {
  return value.length >= 10 && value.length <= 15 && value !== "21600000000";
}

app.get("/api/config", async (req, res) => {
  try {
    const settings = await readStoreSettings();
    const whatsapp = settings.whatsapp || "";
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
      store: STORE,
      currency: CURRENCY
    });
  } catch (error) {
    console.error("Could not load public store settings:", error);
    res.status(500).json({ error: "Could not load store configuration" });
  }
});

app.get("/api/admin/settings", auth, role("admin"), async (req, res) => {
  try {
    const settings = await readStoreSettings();
    res.json({
      whatsapp: settings.whatsapp || "",
      contact_phone: settings.contact_phone || "",
      contact_email: settings.contact_email || "",
      contact_address: settings.contact_address || "",
      opening_hours: settings.opening_hours || "",
      social_facebook: settings.social_facebook || "",
      social_instagram: settings.social_instagram || "",
      social_tiktok: settings.social_tiktok || ""
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
    social_tiktok: 500
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

  const entries = Object.entries(settings);
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
    "SELECT id, name, icon FROM categories WHERE active = TRUE ORDER BY sort_order, id"
  );
  res.json(result.rows);
});
app.get("/api/admin/categories", auth, async (req, res) => {
  const result = await pool.query(
    `SELECT c.id, c.name, c.icon, c.active, c.sort_order, COUNT(p.id)::INTEGER AS product_count
     FROM categories c LEFT JOIN products p ON p.category_id = c.id
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
  if (!name || name.length > 100) return res.status(400).json({ error: "اسم القسم مطلوب (حتى 100 حرف)" });
  if (!["tag", "clothing", "bag", "watch", "accessory"].includes(icon)) {
    return res.status(400).json({ error: "أيقونة القسم غير صالحة" });
  }
  try {
    const result = await pool.query(
      `INSERT INTO categories(name, icon, sort_order)
       VALUES($1, $2, COALESCE((SELECT MAX(sort_order) + 1 FROM categories), 0))
       RETURNING id`,
      [name, icon]
    );
    res.status(201).json({ id: result.rows[0].id });
  } catch (error) {
    if (error.code === "23505") return res.status(400).json({ error: "القسم موجود بالفعل" });
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
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "معرّف القسم غير صالح" });
  if (!name || name.length > 100) return res.status(400).json({ error: "اسم القسم مطلوب (حتى 100 حرف)" });
  if (!["tag", "clothing", "bag", "watch", "accessory"].includes(icon)) {
    return res.status(400).json({ error: "أيقونة القسم غير صالحة" });
  }
  if (typeof active !== "boolean") return res.status(400).json({ error: "حالة القسم غير صالحة" });
  try {
    const result = await pool.query(
      "UPDATE categories SET name = $1, icon = $2, active = $3 WHERE id = $4 RETURNING id",
      [name, icon, active, id]
    );
    if (!result.rowCount) return res.status(404).json({ error: "القسم غير موجود" });
    res.json({ ok: true });
  } catch (error) {
    if (error.code === "23505") return res.status(400).json({ error: "القسم موجود بالفعل" });
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
  if (category) products = products.filter(product => String(product.category_id) === String(category));
  res.json(products);
});
app.get("/api/admin/products", auth, async (req, res) => res.json(await productRows(true)));

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
       WHERE o.status <> 'cancelled' AND o.inventory_deducted = TRUE
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

app.post("/api/products", auth, role("admin", "manager"), upload.array("images", 8), async (req, res) => {
  const product = parseProductInput(req.body);
  if (!product) {
    removeUploadedFiles(req.files);
    return res.status(400).json({ error: "الاسم والسعر مطلوبان" });
  }
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    if (product.advertised) {
      await client.query("UPDATE products SET advertised = FALSE WHERE advertised = TRUE");
    }
    const result = await client.query(
      `INSERT INTO products(name, description, category_id, price, delivery_price, old_price, stock, advertised)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [product.name, product.description, product.categoryId, product.price, product.deliveryPrice,
        product.oldPrice, product.stock, product.advertised]
    );
    const productId = result.rows[0].id;
    for (const file of req.files || []) {
      await client.query("INSERT INTO product_images(product_id, path) VALUES($1, $2)", [productId, `/uploads/${file.filename}`]);
    }
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
    removeUploadedFiles(req.files);
    throw error;
  } finally {
    if (client) client.release();
  }
});

app.put("/api/products/:id", auth, role("admin", "manager"), upload.array("images", 8), async (req, res) => {
  const product = parseProductInput(req.body);
  if (!product) {
    removeUploadedFiles(req.files);
    return res.status(400).json({ error: "الاسم والسعر مطلوبان" });
  }
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const existing = await client.query("SELECT id, name, stock FROM products WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (!existing.rowCount) {
      await client.query("ROLLBACK");
      removeUploadedFiles(req.files);
      return res.status(404).json({ error: "المنتج غير موجود" });
    }
    if (product.advertised) {
      await client.query("UPDATE products SET advertised = FALSE WHERE advertised = TRUE AND id <> $1", [req.params.id]);
    }
    await client.query(
      `UPDATE products SET name=$1, description=$2, category_id=$3, price=$4, delivery_price=$5, old_price=$6,
       stock=$7, active=$8, advertised=$9 WHERE id=$10`,
      [product.name, product.description, product.categoryId, product.price, product.deliveryPrice,
        product.oldPrice, product.stock, product.active, product.advertised, req.params.id]
    );
    for (const file of req.files || []) {
      await client.query("INSERT INTO product_images(product_id, path) VALUES($1, $2)", [req.params.id, `/uploads/${file.filename}`]);
    }
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
    removeUploadedFiles(req.files);
    throw error;
  } finally {
    if (client) client.release();
  }
});
app.delete("/api/products/:id", auth, role("admin", "manager"), async (req, res) => {
  const productId = Number(req.params.id);
  if (!Number.isInteger(productId) || productId < 1) return res.status(400).json({ error: "معرّف المنتج غير صالح" });
  const client = await pool.connect();
  let imagePaths = [];
  try {
    await client.query("BEGIN");
    const product = await client.query("SELECT id FROM products WHERE id = $1 FOR UPDATE", [productId]);
    if (!product.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "المنتج غير موجود" });
    }
    const images = await client.query("SELECT path FROM product_images WHERE product_id = $1", [productId]);
    imagePaths = images.rows.map(image => image.path);
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
  for (const imagePath of imagePaths) {
    const filePath = path.join(uploadDir, path.basename(imagePath));
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (error) {
      console.error("Could not remove product image:", error);
    }
  }
  res.json({ ok: true });
});
app.delete("/api/products/:id/images/:imageId", auth, role("admin", "manager"), async (req, res) => {
  const result = await pool.query(
    "DELETE FROM product_images WHERE id = $1 AND product_id = $2 RETURNING path",
    [req.params.imageId, req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: "الصورة غير موجودة" });
  const filePath = path.join(__dirname, result.rows[0].path.replace(/^\/uploads\//, "uploads/"));
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (error) {
    console.error("Could not remove product image:", error);
  }
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
    for (const item of items) {
      const productId = Number(item?.product_id);
      const quantity = Number(item?.quantity);
        if (!Number.isInteger(productId) || productId < 1 || productId > 2147483647 ||
          !Number.isSafeInteger(quantity) || quantity < 1) {
        throw new OrderValidationError("الكمية غير متوفرة: منتج");
      }
      const combinedQuantity = (requestedItems.get(productId) || 0) + quantity;
      if (!Number.isSafeInteger(combinedQuantity)) throw new OrderValidationError("الكمية غير متوفرة: منتج");
      requestedItems.set(productId, combinedQuantity);
    }
    for (const [productId, quantity] of [...requestedItems].sort(([left], [right]) => left - right)) {
      const result = await client.query("SELECT * FROM products WHERE id = $1 AND active = TRUE FOR UPDATE", [productId]);
      const product = result.rows[0];
      if (!product || quantity > product.stock) {
        throw new OrderValidationError(`الكمية غير متوفرة: ${product?.name || "منتج"}`);
      }
      subtotal += Number(product.price) * quantity;
      deliveryFee = Math.max(deliveryFee, Number(product.delivery_price || 0));
      if (!Number.isFinite(subtotal + deliveryFee) || subtotal + deliveryFee > MAX_MONEY) {
        throw new OrderValidationError("المجموع يتجاوز الحد المسموح");
      }
      normalizedItems.push({ product, quantity });
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
        `INSERT INTO order_items(order_id, product_id, product_name, price, delivery_price, quantity)
         VALUES($1, $2, $3, $4, $5, $6)`,
        [orderId, item.product.id, item.product.name, item.product.price,
          item.product.delivery_price || 0, item.quantity]
      );
    }
    await client.query("COMMIT");
    publishAdminEvent("new-order", { order_id: orderId, total });
    res.json({ order_id: orderId, subtotal, delivery_fee: deliveryFee, total, payment_method: PAYMENT_METHOD });
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
  const validStatuses = ["new", "confirmed", "shipped", "delivered", "cancelled"];
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
      } else if (req.body.status === "cancelled" && inventoryDeducted) {
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
    if (["shipped", "delivered"].includes(order.status) || order.shipment_id) {
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
     COALESCE(SUM(CASE WHEN o.status <> 'cancelled' THEN o.total ELSE 0 END), 0) AS spent
     FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
     GROUP BY c.id ORDER BY c.id DESC`
  );
  res.json(result.rows);
});
app.get("/api/stats", auth, async (req, res) => {
  const [products, customers, orders, revenue] = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS n FROM products WHERE active = TRUE"),
    pool.query("SELECT COUNT(*)::int AS n FROM customers"),
    pool.query("SELECT COUNT(*)::int AS n FROM orders"),
    pool.query("SELECT COALESCE(SUM(total), 0) AS n FROM orders WHERE status <> 'cancelled'")
  ]);
  res.json({
    products: products.rows[0].n,
    customers: customers.rows[0].n,
    orders: orders.rows[0].n,
    revenue: revenue.rows[0].n
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

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename=invoice-${order.id}.pdf`);

  const document = new PDFDocument({ size: "A4", margin: 44, bufferPages: true });
  document.pipe(res);

  const accent = "#464feb";
  const deep = "#172554";
  const text = "#1f2937";
  const soft = "#f5f7fb";
  const border = "#e5e7eb";
  const pageWidth = document.page.width;
  const pageHeight = document.page.height;
  const left = 44;
  const right = pageWidth - 44;
  const contentWidth = right - left;
  const footerY = pageHeight - 66;
  const columns = {
    product: { x: left + 14, width: 238 },
    quantity: { x: left + 266, width: 42 },
    unitPrice: { x: left + 320, width: 86 },
    total: { x: left + 416, width: 82 }
  };

  function drawTableHeader(y) {
    document.fillColor(deep).roundedRect(left, y, contentWidth, 30, 7).fill();
    document.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9)
      .text("Produit", columns.product.x, y + 10, { width: columns.product.width });
    document.text("Qté", columns.quantity.x, y + 10, { width: columns.quantity.width, align: "center" });
    document.text("Prix unitaire", columns.unitPrice.x, y + 10, { width: columns.unitPrice.width, align: "right" });
    document.text("Total", columns.total.x, y + 10, { width: columns.total.width, align: "right" });
    return y + 38;
  }

  function drawPageHeader(firstPage) {
    if (firstPage) {
      document.fillColor(deep).rect(0, 0, pageWidth, 116).fill();
      document.fillColor("#ffffff").font("Helvetica-Bold").fontSize(25)
        .text(STORE, left, 34, { width: 300, lineBreak: false });
      document.fillColor("#c7d2fe").font("Helvetica-Bold").fontSize(10)
        .text("FACTURE", right - 126, 27, { width: 126, align: "right" });
      document.fillColor("#ffffff").font("Helvetica-Bold").fontSize(19)
        .text(`#${order.id}`, right - 126, 47, { width: 126, align: "right" });

      const infoY = 140;
      const cardWidth = (contentWidth - 14) / 2;
      document.fillColor(soft).roundedRect(left, infoY, cardWidth, 128, 10).fill();
      document.fillColor(soft).roundedRect(left + cardWidth + 14, infoY, cardWidth, 128, 10).fill();

      document.fillColor(accent).font("Helvetica-Bold").fontSize(9).text("CLIENT", left + 16, infoY + 15);
      document.fillColor(text).font("Helvetica-Bold").fontSize(13)
        .text(String(order.customer_name || "-"), left + 16, infoY + 34, { width: cardWidth - 32 });
      document.fillColor("#4b5563").font("Helvetica").fontSize(9)
        .text(`Téléphone : ${order.phone || "-"}`, left + 16, infoY + 62, { width: cardWidth - 32 });
      document.text(`Adresse : ${[order.address, order.city].filter(Boolean).join(", ") || "-"}`,
        left + 16, infoY + 82, { width: cardWidth - 32, height: 34, ellipsis: true });

      const detailX = left + cardWidth + 30;
      document.fillColor(accent).font("Helvetica-Bold").fontSize(9).text("DÉTAILS DE LA FACTURE", detailX, infoY + 15);
      document.fillColor("#4b5563").font("Helvetica").fontSize(9)
        .text(`Date : ${createdAt}`, detailX, infoY + 39, { width: cardWidth - 32 });
      document.text("Paiement : à la livraison", detailX, infoY + 59, { width: cardWidth - 32 });
      return drawTableHeader(292);
    }

    document.fillColor(deep).rect(0, 0, pageWidth, 64).fill();
    document.fillColor("#ffffff").font("Helvetica-Bold").fontSize(15)
      .text(STORE, left, 23, { width: 300, lineBreak: false });
    document.fillColor("#c7d2fe").font("Helvetica-Bold").fontSize(10)
      .text(`FACTURE #${order.id}`, right - 180, 25, { width: 180, align: "right" });
    return drawTableHeader(82);
  }

  let y = drawPageHeader(true);
  for (const item of items.rows) {
    const productName = String(item.product_name || "Produit");
    const productOptions = { width: columns.product.width, font: "Helvetica", fontSize: 9 };
    const rowHeight = Math.max(34, document.heightOfString(productName, productOptions) + 18);
    if (y + rowHeight + 150 > footerY) {
      document.addPage();
      y = drawPageHeader(false);
    }
    document.fillColor(y % 2 ? "#ffffff" : soft).roundedRect(left, y, contentWidth, rowHeight, 5).fill();
    const textY = y + Math.max(9, (rowHeight - 12) / 2);
    document.fillColor(text).font("Helvetica").fontSize(9)
      .text(productName, columns.product.x, y + 9, { width: columns.product.width, height: rowHeight - 16, ellipsis: true });
    document.text(String(item.quantity || 0), columns.quantity.x, textY, { width: columns.quantity.width, align: "center" });
    document.text(`${Number(item.price).toFixed(3).replace(".", ",")} ${CURRENCY}`, columns.unitPrice.x, textY, { width: columns.unitPrice.width, align: "right" });
    document.font("Helvetica-Bold").text(
      `${(Number(item.price) * Number(item.quantity)).toFixed(3).replace(".", ",")} ${CURRENCY}`,
      columns.total.x, textY, { width: columns.total.width, align: "right" }
    );
    y += rowHeight + 4;
  }

  if (y + 142 > footerY) {
    document.addPage();
    y = drawPageHeader(false);
  }
  const totalsY = y + 14;
  const totalsX = right - 230;
  document.fillColor(soft).roundedRect(totalsX, totalsY, 230, 126, 10).fill();
  document.fillColor(text).font("Helvetica").fontSize(10).text("Sous-total", totalsX + 16, totalsY + 18);
  document.font("Helvetica-Bold").text(`${subtotal.toFixed(3).replace(".", ",")} ${CURRENCY}`, totalsX + 100, totalsY + 18, { width: 112, align: "right" });
  document.font("Helvetica").text("Livraison", totalsX + 16, totalsY + 43);
  document.font("Helvetica-Bold").text(`${deliveryFee.toFixed(3).replace(".", ",")} ${CURRENCY}`, totalsX + 100, totalsY + 43, { width: 112, align: "right" });
  document.strokeColor(border).lineWidth(1).moveTo(totalsX + 16, totalsY + 70).lineTo(totalsX + 214, totalsY + 70).stroke();
  document.fillColor(deep).font("Helvetica-Bold").fontSize(11).text("TOTAL", totalsX + 16, totalsY + 91);
  document.fillColor(accent).fontSize(14).text(`${Number(order.total).toFixed(3).replace(".", ",")} ${CURRENCY}`,
    totalsX + 90, totalsY + 88, { width: 122, align: "right" });

  const pageRange = document.bufferedPageRange();
  for (let page = pageRange.start; page < pageRange.start + pageRange.count; page += 1) {
    document.switchToPage(page);
    document.strokeColor(border).lineWidth(1).moveTo(left, footerY - 11).lineTo(right, footerY - 11).stroke();
    document.fillColor("#6b7280").font("Helvetica").fontSize(8)
      .text("Merci pour votre confiance.", left, footerY, { width: contentWidth, align: "center" });
    document.fillColor("#9ca3af").fontSize(8)
      .text(`${page + 1} / ${pageRange.count}`, left, footerY + 12, { width: contentWidth, align: "right" });
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
      sort_order INTEGER
    );
    ALTER TABLE categories ADD COLUMN IF NOT EXISTS icon TEXT NOT NULL DEFAULT 'tag';
    ALTER TABLE categories ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE categories ADD COLUMN IF NOT EXISTS sort_order INTEGER;
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
      delivery_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
      old_price NUMERIC(12, 2),
      stock INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      advertised BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE products ADD COLUMN IF NOT EXISTS advertised BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS delivery_price NUMERIC(12, 2) NOT NULL DEFAULT 0;
    CREATE UNIQUE INDEX IF NOT EXISTS products_single_advertised_idx
      ON products (advertised) WHERE advertised = TRUE AND active = TRUE;
    CREATE TABLE IF NOT EXISTS product_images (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      path TEXT NOT NULL
    );
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC(12, 2) NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'cash_on_delivery';
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
      delivery_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
      quantity INTEGER NOT NULL
    );
    ALTER TABLE order_items ADD COLUMN IF NOT EXISTS delivery_price NUMERIC(12, 2) NOT NULL DEFAULT 0;
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
  `);
  await pool.query(
    `INSERT INTO store_settings(key, value) VALUES
       ('whatsapp', $1),
       ('contact_phone', ''),
       ('contact_email', ''),
       ('contact_address', ''),
       ('opening_hours', ''),
       ('social_facebook', ''),
       ('social_instagram', ''),
       ('social_tiktok', '')
     ON CONFLICT (key) DO NOTHING`,
    [WHATSAPP_CONFIGURED ? WA : ""]
  );
  const passwordHash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || "Admin@12345", 12);
  await pool.query(
    `INSERT INTO admins(username, password_hash, role)
     SELECT $1, $2, 'admin' WHERE NOT EXISTS (SELECT 1 FROM admins)
     ON CONFLICT (username) DO NOTHING`,
    [process.env.ADMIN_USER || "admin", passwordHash]
  );
}

initializeDatabase()
  .then(() => app.listen(PORT, () => console.log(`${STORE}: http://localhost:${PORT}`)))
  .catch(error => {
    console.error("Could not initialize PostgreSQL:", error.message);
    process.exitCode = 1;
    pool.end();
  });