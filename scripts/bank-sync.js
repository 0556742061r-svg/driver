// bank-sync.js
// Pulls recent transactions from Isracard and Max using the user's own login
// credentials (via the open-source `israeli-bank-scrapers` library), and
// writes them into the same Firestore document shape that "המונה שלי" uses,
// so the app can display them read-only.
//
// This script is meant to run inside a GitHub Action (see
// .github/workflows/bank-sync.yml), reading all secrets from environment
// variables that you set up as encrypted GitHub Secrets. It never receives
// credentials any other way.

const { CompanyTypes, createScraper } = require('israeli-bank-scrapers');
const admin = require('firebase-admin');

const BANK_TRANSACTIONS_KEY = 'banktx_v1';
const DAYS_BACK = 35; // how many days of history to pull each run

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return v;
}

async function scrapeIsracard() {
  const options = {
    companyId: CompanyTypes.isracard,
    startDate: new Date(Date.now() - DAYS_BACK * 86400000),
    combineInstallments: false,
    showBrowser: false,
  };
  const credentials = {
    id: requireEnv('ISRACARD_ID'),
    password: requireEnv('ISRACARD_PASSWORD'),
    card6Digits: requireEnv('ISRACARD_CARD6DIGITS'),
  };
  const scraper = createScraper(options);
  const result = await scraper.scrape(credentials);
  if (!result.success) {
    console.error('Isracard scrape failed:', result.errorType, result.errorMessage);
    return [];
  }
  const txs = [];
  (result.accounts || []).forEach(acc => {
    (acc.txns || []).forEach(t => {
      txs.push({
        source: 'isracard',
        account: acc.accountNumber,
        date: t.date,
        description: t.description,
        amount: t.chargedAmount != null ? t.chargedAmount : t.originalAmount,
        status: t.status,
      });
    });
  });
  return txs;
}

async function scrapeMax() {
  const options = {
    companyId: CompanyTypes.max,
    startDate: new Date(Date.now() - DAYS_BACK * 86400000),
    combineInstallments: false,
    showBrowser: false,
  };
  const credentials = {
    username: requireEnv('MAX_USERNAME'),
    password: requireEnv('MAX_PASSWORD'),
  };
  const scraper = createScraper(options);
  const result = await scraper.scrape(credentials);
  if (!result.success) {
    console.error('Max scrape failed:', result.errorType, result.errorMessage);
    return [];
  }
  const txs = [];
  (result.accounts || []).forEach(acc => {
    (acc.txns || []).forEach(t => {
      txs.push({
        source: 'max',
        account: acc.accountNumber,
        date: t.date,
        description: t.description,
        amount: t.chargedAmount != null ? t.chargedAmount : t.originalAmount,
        status: t.status,
      });
    });
  });
  return txs;
}

async function main() {
  const uid = requireEnv('FIREBASE_UID');
  const serviceAccountJson = requireEnv('FIREBASE_SERVICE_ACCOUNT');
  const serviceAccount = JSON.parse(serviceAccountJson);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  const db = admin.firestore();

  console.log('Scraping Isracard...');
  const isracardTxs = await scrapeIsracard().catch(e => {
    console.error('Isracard scrape threw:', e.message);
    return [];
  });
  console.log(`Isracard: ${isracardTxs.length} transactions`);

  console.log('Scraping Max...');
  const maxTxs = await scrapeMax().catch(e => {
    console.error('Max scrape threw:', e.message);
    return [];
  });
  console.log(`Max: ${maxTxs.length} transactions`);

  const allTxs = [...isracardTxs, ...maxTxs].sort((a, b) => new Date(b.date) - new Date(a.date));

  const docRef = db.collection('users').doc(uid).collection('data').doc(BANK_TRANSACTIONS_KEY);
  await docRef.set({
    value: JSON.stringify(allTxs),
    updatedAt: Date.now(),
  });

  console.log(`Wrote ${allTxs.length} total transactions to Firestore for uid ${uid}.`);
}

main().then(() => process.exit(0)).catch(e => {
  console.error('bank-sync failed:', e);
  process.exit(1);
});
