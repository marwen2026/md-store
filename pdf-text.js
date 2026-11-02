const { ArabicShaper } = require("arabic-persian-reshaper");
const bidi = require("bidi-js")();

const ARABIC_SCRIPT = /\p{Script=Arabic}/u;
const ARABIC_TEXT = /\p{Script=Arabic}/u;

function registerArabicFonts(document) {
  document.registerFont(
    "Arabic",
    require.resolve("@fontsource/noto-naskh-arabic/files/noto-naskh-arabic-arabic-400-normal.woff")
  );
  document.registerFont(
    "Arabic-Bold",
    require.resolve("@fontsource/noto-naskh-arabic/files/noto-naskh-arabic-arabic-700-normal.woff")
  );
}

function getPdfTextRuns(value, latinFont) {
  let shapedText = ArabicShaper.convertArabic(String(value ?? ""));
  const levels = bidi.getEmbeddingLevels(shapedText, "rtl");
  for (const [start, end] of bidi.getReorderSegments(shapedText, levels)) {
    shapedText = shapedText.slice(0, start)
      + Array.from(shapedText.slice(start, end + 1)).reverse().join("")
      + shapedText.slice(end + 1);
  }

  const runs = [];
  let previousWasArabic = false;
  for (const codepoint of Array.from(shapedText)) {
    const isArabic = ARABIC_SCRIPT.test(codepoint)
      || (/\p{M}/u.test(codepoint) && previousWasArabic);
    const font = isArabic ? (latinFont === "Helvetica-Bold" ? "Arabic-Bold" : "Arabic") : latinFont;
    const previous = runs[runs.length - 1];
    if (previous?.font === font) {
      previous.text += codepoint;
    } else {
      runs.push({ font, text: codepoint });
    }
    previousWasArabic = isArabic;
  }
  return runs;
}

function pdfTextHeight(document, value, options) {
  const { font: latinFont, fontSize, width } = options;
  if (!ARABIC_TEXT.test(String(value ?? ""))) {
    return document.heightOfString(String(value ?? ""), options);
  }

  const runs = getPdfTextRuns(value, latinFont);
  let totalWidth = 0;
  let lineHeight = 0;
  for (const run of runs) {
    document.font(run.font).fontSize(fontSize);
    totalWidth += document.widthOfString(run.text);
    lineHeight = Math.max(lineHeight, document.currentLineHeight(true));
  }
  document.font(latinFont).fontSize(fontSize);
  return Math.max(1, Math.ceil(totalWidth / width)) * lineHeight;
}

function drawPdfText(document, value, x, y, options) {
  const text = String(value ?? "");
  if (!ARABIC_TEXT.test(text)) {
    return document.text(text, x, y, options);
  }

  const { font: latinFont, ...textOptions } = options;
  const runs = getPdfTextRuns(text, latinFont);
  let drawX = x;
  if (textOptions.width && (!textOptions.align || textOptions.align === "right")) {
    let textWidth = 0;
    for (const run of runs) {
      document.font(run.font).fontSize(textOptions.fontSize);
      textWidth += document.widthOfString(run.text);
    }
    if (textWidth <= textOptions.width) {
      drawX += textOptions.width - textWidth;
      textOptions.width = textWidth;
    }
  }
  runs.forEach((run, index) => {
    document.font(run.font);
    const runOptions = index === 0
      ? { ...textOptions, align: "left", continued: index < runs.length - 1 }
      : { continued: index < runs.length - 1 };
    if (index === 0) {
      document.text(run.text, drawX, y, runOptions);
    } else {
      document.text(run.text, runOptions);
    }
  });
  document.font(latinFont).fontSize(textOptions.fontSize);
}

module.exports = { drawPdfText, pdfTextHeight, registerArabicFonts };
