import puppeteer from "puppeteer-core";
import chromium  from "@sparticuz/chromium";

/**
 * Render HTML to a PDF buffer using headless Chromium.
 * On Vercel uses @sparticuz/chromium binary; locally falls back to
 * PUPPETEER_EXECUTABLE_PATH or a system Chrome path.
 */
export async function htmlToPdf(html, opts = {}) {
  const isProd = process.env.NODE_ENV === "production" || process.env.VERCEL === "1";

  const launchOpts = isProd
    ? {
        args: chromium.args,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
        defaultViewport: chromium.defaultViewport,
      }
    : {
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        executablePath:
          process.env.PUPPETEER_EXECUTABLE_PATH ??
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        headless: true,
      };

  const browser = await puppeteer.launch(launchOpts);
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdf = await page.pdf({
      format: opts.format ?? "A4",
      printBackground: true,
      margin: opts.margin ?? { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" },
    });
    return pdf;
  } finally {
    await browser.close();
  }
}
