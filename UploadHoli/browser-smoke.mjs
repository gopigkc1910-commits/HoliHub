import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const baseUrl = "http://127.0.0.1:3000";
const mode = (process.argv[2] || "all").toLowerCase();
const validModes = new Set(["public", "private", "all"]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForHealth(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(baseUrl + "/api/health");
      if (res.ok) return;
    } catch (_) {}
    await delay(300);
  }
  throw new Error("Server did not become healthy in time.");
}

function makeTempWishesFile(label) {
  return path.join(__dirname, `.tmp-wishes-${label}.json`);
}

async function runPublicFlow(page) {
  await page.goto(baseUrl + "/happyHoli.html", { waitUntil: "networkidle" });
  await page.fill("#senderInput", "Gopi");
  await page.fill("#nameInput", "Aarav");
  await page.fill("#messageInput", "Wishing you a colorful and joyful Holi celebration.");
  await page.fill("#spotifyInput", "Holi songs");
  await page.selectOption("#themeInput", "sunset");
  await page.selectOption("#visibilityInput", "public");

  await page.evaluate(() => generateLink());
  await page.waitForTimeout(1200);

  const shareDebug = await page.evaluate(() => ({
    shareStatus: document.getElementById("shareStatus")?.textContent || "",
    generatedShareLinkValue: typeof generatedShareLink !== "undefined" ? generatedShareLink : "",
    qrHidden: document.getElementById("qrPanel")?.classList.contains("is-hidden")
  }));
  assert(/link/i.test(shareDebug.shareStatus), "Public share state did not update. " + JSON.stringify(shareDebug));

  await page.evaluate(() => toggleQrPanel());
  await page.waitForTimeout(500);
  const qrDebug = await page.evaluate(() => ({
    qrCaption: document.getElementById("qrCaption")?.textContent || "",
    qrSrc: document.getElementById("qrImage")?.getAttribute("src") || "",
    panelHidden: document.getElementById("qrPanel")?.classList.contains("is-hidden"),
    generatedShareLinkValue: typeof generatedShareLink !== "undefined" ? generatedShareLink : ""
  }));
  assert(qrDebug.qrSrc.includes("qrserver.com"), "Public QR code did not render. " + JSON.stringify(qrDebug));
  assert(qrDebug.panelHidden === false, "Public QR panel did not open. " + JSON.stringify(qrDebug));

  await page.evaluate(() => favoriteCurrentDraft());
  await page.waitForTimeout(300);
  const favoritesText = await page.locator("#favoriteWishes").textContent();
  assert(favoritesText && !/No favorites saved yet/i.test(favoritesText), "Draft favorite was not saved.");

  await page.evaluate(() => nativeShareLink());
  await page.waitForTimeout(300);

  const pulseText = await page.locator("#healthBackend").textContent();
  assert(pulseText && !/Checking/i.test(pulseText), "Health pulse did not load.");

  const generatedLink = await page.evaluate(() => typeof generatedShareLink !== "undefined" ? generatedShareLink : "");
  assert(generatedLink && /\/wish\//.test(generatedLink), "Public generated wish link missing.");

  await page.goto(generatedLink, { waitUntil: "networkidle" });
  await page.waitForSelector("#greetingSection");
  await page.evaluate(() => favoriteActiveGreeting());
  await page.waitForTimeout(300);
  await page.click("button[onclick*=\"reactToWish('love')\"]");
  await page.waitForTimeout(500);

  const reactions = await page.locator("#wishReactions").textContent();
  assert(reactions && /Reactions:\s*[1-9]/.test(reactions), "Public reaction was not recorded.");
}

async function runPrivateFlow(page) {
  await page.goto(baseUrl + "/happyHoli.html", { waitUntil: "networkidle" });
  await page.fill("#senderInput", "Gopi");
  await page.fill("#nameInput", "Riya");
  await page.fill("#messageInput", "This private Holi note is only for you.");
  await page.fill("#spotifyInput", "Private acoustic");
  await page.selectOption("#visibilityInput", "private");
  await page.fill("#accessCodeInput", "4321");
  await page.selectOption("#expiryInput", "7");

  await page.evaluate(() => generateLink());
  await page.waitForTimeout(1200);

  const privateState = await page.evaluate(() => ({
    shareStatus: document.getElementById("shareStatus")?.textContent || "",
    generatedShareLinkValue: typeof generatedShareLink !== "undefined" ? generatedShareLink : "",
    qrSrc: document.getElementById("qrImage")?.getAttribute("src") || ""
  }));
  assert(/Private link/i.test(privateState.shareStatus) || /Private link copied/i.test(privateState.shareStatus), "Private share state did not update. " + JSON.stringify(privateState));
  assert(privateState.generatedShareLinkValue && /\/wish\//.test(privateState.generatedShareLinkValue), "Private generated link missing.");

  await page.goto(privateState.generatedShareLinkValue, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);

  const promptMessages = [];
  page.on("dialog", async (dialog) => {
    promptMessages.push(dialog.message());
    await dialog.accept("4321");
  });

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#greetingSection");

  const privacyText = await page.locator("#wishPrivacy").textContent();
  assert(/Private link/i.test(privacyText), "Private greeting privacy info missing.");
  assert(/Access code required/i.test(privacyText), "Private greeting access-code info missing.");

  await page.click("button[onclick*=\"reactToWish('love')\"]");
  await page.waitForTimeout(500);
  const reactions = await page.locator("#wishReactions").textContent();
  assert(reactions && /Reactions:\s*[1-9]/.test(reactions), "Private reaction was not recorded.");
  assert(promptMessages.length > 0, "Private greeting did not request an access code.");
}

if (!validModes.has(mode)) {
  throw new Error(`Unsupported test mode "${mode}". Use public, private, or all.`);
}

const wishesFile = makeTempWishesFile(mode);
try {
  if (fs.existsSync(wishesFile)) fs.unlinkSync(wishesFile);
} catch (_) {}

const server = spawn(process.execPath, ["server.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    WISHES_FILE: wishesFile
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let serverStdout = "";
let serverStderr = "";
server.stdout.on("data", (chunk) => {
  serverStdout += String(chunk);
});
server.stderr.on("data", (chunk) => {
  serverStderr += String(chunk);
});

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const pageErrors = [];
const appNetworkErrors = [];

page.on("pageerror", (err) => {
  pageErrors.push(String(err && err.message ? err.message : err));
});
page.on("response", (response) => {
  const url = response.url();
  if (!url.startsWith(baseUrl)) return;
  const status = response.status();
  if (status < 400) return;
  if (status === 403 && /\/api\/wishes\//.test(url)) return;
  appNetworkErrors.push(`${status} ${url}`);
});

try {
  await waitForHealth();

  if (mode === "public" || mode === "all") {
    await runPublicFlow(page);
  }
  if (mode === "private" || mode === "all") {
    await page.context().clearCookies();
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    }).catch(() => {});
    await runPrivateFlow(page);
  }

  if (pageErrors.length || appNetworkErrors.length) {
    throw new Error(
      "Browser errors detected.\nPage errors: " +
      JSON.stringify(pageErrors) +
      "\nApp network errors: " +
      JSON.stringify(appNetworkErrors)
    );
  }

  console.log(`BROWSER_SMOKE_OK:${mode}`);
} finally {
  await browser.close();
  if (!server.killed) server.kill("SIGTERM");
  await delay(300);
  if (!server.killed) server.kill("SIGKILL");
  try {
    if (fs.existsSync(wishesFile)) fs.unlinkSync(wishesFile);
  } catch (_) {}
  if (server.exitCode && server.exitCode !== 0) {
    console.error("SERVER_STDOUT:", serverStdout);
    console.error("SERVER_STDERR:", serverStderr);
  }
}
