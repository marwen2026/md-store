function normalizeColorHex(value) {
  const color = String(value || "").trim().toUpperCase();
  return /^#[0-9A-F]{6}$/.test(color) ? color : null;
}

function colorName(value, language = "ar") {
  const color = normalizeColorHex(value);
  if (!color) return "";
  const [red, green, blue] = [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16) / 255);
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const difference = maximum - minimum;
  const saturation = maximum === 0 ? 0 : difference / maximum;
  let hue = 0;
  if (difference) {
    if (maximum === red) hue = ((green - blue) / difference) % 6;
    else if (maximum === green) hue = (blue - red) / difference + 2;
    else hue = (red - green) / difference + 4;
    hue = (hue * 60 + 360) % 360;
  }

  const french = language === "fr";
  let colorKey;
  if (saturation < 0.16) {
    colorKey = maximum < 0.14 ? "black" : maximum > 0.9 ? "white" : "gray";
  } else if (hue < 12 || hue >= 345) colorKey = "red";
  else if (hue < 32) colorKey = "orange";
  else if (hue < 48) colorKey = "gold";
  else if (hue < 68) colorKey = "yellow";
  else if (hue < 155) colorKey = "green";
  else if (hue < 195) colorKey = "cyan";
  else if (hue < 255) colorKey = "blue";
  else if (hue < 285) colorKey = "purple";
  else if (hue < 320) colorKey = "pink";
  else colorKey = "red";

  const names = {
    ar: {
      black: "أسود", white: "أبيض", gray: "رمادي", red: "أحمر", orange: "برتقالي",
      gold: "ذهبي", yellow: "أصفر", green: "أخضر", cyan: "سماوي", blue: "أزرق",
      purple: "بنفسجي", pink: "وردي", dark: "داكن", light: "فاتح"
    },
    fr: {
      black: "noir", white: "blanc", gray: "gris", red: "rouge", orange: "orange",
      gold: "doré", yellow: "jaune", green: "vert", cyan: "cyan", blue: "bleu",
      purple: "violet", pink: "rose", dark: "foncé", light: "clair"
    }
  }[french ? "fr" : "ar"];
  const withShade = shade => `${names[colorKey]} ${names[shade]}`;

  if (colorKey === "black" || colorKey === "white") return names[colorKey];
  if (colorKey === "gray") {
    if (maximum < 0.38) return french ? `${names.dark} ${names.gray}` : `${names.gray} ${names.dark}`;
    if (maximum > 0.72) return french ? `${names.light} ${names.gray}` : `${names.gray} ${names.light}`;
    return names.gray;
  }
  if (maximum < 0.55) return withShade("dark");
  if (maximum > 0.88 && saturation < 0.55) return withShade("light");
  return names[colorKey];
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { colorName, normalizeColorHex };
} else {
  globalThis.StoreColor = { colorName, normalizeColorHex };
}
