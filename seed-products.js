const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: 'postgresql://postgres:Chankouti2008@127.0.0.1:5432/md_store'
});

const categories = ['Électronique', 'Maison', 'Mode', 'Sport'];
const products = [
  { name: 'Smartphone X10', description: 'Téléphone premium avec écran 6.7 pouces et photo intelligente.', category: 'Électronique', price: 899.00, old_price: 999.00, stock: 18 },
  { name: 'Casque Audio Pro', description: 'Casque sans fil avec son immersif et autonomie 30h.', category: 'Électronique', price: 219.00, old_price: 279.00, stock: 22 },
  { name: 'Sac Édition', description: 'Sac élégant pour le quotidien et les sorties.', category: 'Mode', price: 149.00, old_price: 199.00, stock: 28 },
  { name: 'Veste Sport', description: 'Veste légère et respirante pour le sport.', category: 'Sport', price: 189.00, old_price: 239.00, stock: 16 },
  { name: 'Lampadaire Moderne', description: 'Éclairage design pour salon et chambre.', category: 'Maison', price: 129.00, old_price: 169.00, stock: 24 },
];

async function ensureData() {
  for (const categoryName of categories) {
    await pool.query(
      `INSERT INTO categories(name)
       SELECT $1
       WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name = $1)`,
      [categoryName]
    );
  }

  const catRows = await pool.query('SELECT id, name FROM categories');
  const categoryMap = new Map(catRows.rows.map((c) => [c.name, c.id]));

  for (const product of products) {
    const exists = await pool.query('SELECT id FROM products WHERE name = $1', [product.name]);
    if (exists.rowCount > 0) {
      console.log(`Skipping existing product: ${product.name}`);
      continue;
    }

    const imageName = `${product.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.svg`;
    const filePath = path.join(__dirname, 'uploads', imageName);
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
        <rect width="800" height="600" fill="#f8fafc"/>
        <rect x="110" y="110" width="580" height="360" rx="26" fill="#dbeafe"/>
        <rect x="220" y="170" width="360" height="200" rx="20" fill="#ffffff"/>
        <text x="400" y="330" text-anchor="middle" font-size="44" font-family="Arial" font-weight="700" fill="#111827">${product.name}</text>
      </svg>
    `;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, svg.trim());

    const result = await pool.query(
      `INSERT INTO products(name, description, category_id, price, old_price, stock, active)
       VALUES($1, $2, $3, $4, $5, $6, TRUE) RETURNING id`,
      [product.name, product.description, categoryMap.get(product.category), product.price, product.old_price, product.stock]
    );

    await pool.query(
      'INSERT INTO product_images(product_id, path) VALUES($1, $2)',
      [result.rows[0].id, `/uploads/${imageName}`]
    );

    console.log(`Inserted product: ${product.name} -> /uploads/${imageName}`);
  }
}

(async () => {
  try {
    await ensureData();
    console.log('✅ Seed completed successfully.');
  } catch (error) {
    console.error('❌ Seed failed:', error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
