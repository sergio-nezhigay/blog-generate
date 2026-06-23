import cron from 'node-cron';

const APP_URL = process.env.SHOPIFY_APP_URL;
const CRON_SECRET = process.env.CRON_SECRET;

if (!APP_URL || !CRON_SECRET) {
  console.error('[cron] Missing SHOPIFY_APP_URL or CRON_SECRET env vars');
  process.exit(1);
}

async function call(path) {
  try {
    const res = await fetch(`${APP_URL}${path}`, {
      method: 'POST',
      headers: {
        'x-cron-secret': CRON_SECRET,
        'Content-Type': 'application/json',
      },
    });
    const body = await res.text();
    console.log(`[cron] ${path} → ${res.status} ${body.slice(0, 200)}`);
  } catch (e) {
    console.error(`[cron] ${path} failed:`, e.message);
  }
}

// Monday 09:00 UTC — generate weekly content plan
cron.schedule('0 9 * * 1', () => {
  console.log('[cron] Running weekly plan generation...');
  call('/api/cron/weekly');
});

// Daily 10:00 UTC — publish today's planned article
cron.schedule('0 10 * * *', () => {
  console.log('[cron] Running daily article publish...');
  call('/api/cron/daily');
});

// Daily 11:00 UTC — retry in case 10:00 run hit a transient timeout
cron.schedule('0 11 * * *', () => {
  console.log('[cron] Running daily article publish retry...');
  call('/api/cron/daily');
});

console.log('[cron] Scheduler running. Next: Mon 09:00 UTC weekly, daily 10:00 UTC (retry 11:00 UTC).');
