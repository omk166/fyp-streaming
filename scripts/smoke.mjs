import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const count = Number(process.env.PARTICIPANTS || 2);
const seconds = Number(process.env.DURATION || 30);
const mode = process.env.MODE || 'h264';
if (![2,4,6,8].includes(count) || !['h264','simulcast','vp9'].includes(mode) || seconds < 5) throw Error('Invalid scenario');
const runId = `${new Date().toISOString().replace(/[:.]/g,'-')}-${mode}-${count}p`;
const folder = `artifacts/raw/${runId}`;
await mkdir(folder, { recursive: true }); await mkdir('artifacts/screenshots', { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || undefined, args: ['--autoplay-policy=no-user-gesture-required'] });
const contexts = [], pages = [], errors = [];
const checks = [];
let passed = false;
try {
  for (let i = 0; i < count; i++) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); contexts.push(context);
    const page = await context.newPage(); pages.push(page);
    page.on('pageerror', error => errors.push({ peer: i, message: error.message }));
    await page.goto(`http://127.0.0.1:3000/?synthetic=1&mode=${mode}&room=${runId}&run=${runId}-peer${i}`);
    await page.getByRole('button', { name: 'Join room', exact: true }).click();
    await page.waitForFunction(() => window.lab?.joined, null, { timeout: 30000 });
  }
  for (const page of pages) await page.waitForFunction(n => window.lab.consumers.size === (n - 1) * 2, count, { timeout: 30000 });
  checks.push({ name: 'all peers receive expected audio and video tracks', passed: true });
  await pages[0].getByRole('button', { name: 'Mute microphone', exact: true }).click();
  await pages[0].waitForFunction(() => window.lab.producers.find(p => p.kind === 'audio').paused);
  await pages[0].getByRole('button', { name: 'Unmute microphone', exact: true }).click();
  await pages[0].waitForFunction(() => !window.lab.producers.find(p => p.kind === 'audio').paused);
  checks.push({ name: 'microphone producer pause/resume', passed: true });
  await pages[0].getByRole('button', { name: 'Pause camera', exact: true }).click();
  await pages[0].waitForFunction(() => window.lab.producers.find(p => p.kind === 'video').paused);
  await pages[0].getByRole('button', { name: 'Resume camera', exact: true }).click();
  await pages[0].waitForFunction(() => !window.lab.producers.find(p => p.kind === 'video').paused);
  checks.push({ name: 'video producer pause/resume', passed: true });
  await pages[0].locator('#message').fill('Smoke test room message');
  await pages[0].getByRole('button', { name: 'Send', exact: true }).click();
  await pages[1].waitForFunction(() => document.getElementById('chat').textContent.includes('Smoke test room message'));
  checks.push({ name: 'chat delivered to second peer', passed: true });
  await new Promise(resolve => setTimeout(resolve, seconds * 1000));
  for (let i = 0; i < count; i++) {
    const data = await pages[i].evaluate(() => window.lab.export());
    await writeFile(`${folder}/peer-${i}.json`, JSON.stringify(data, null, 2));
    if (data.errors.length) throw Error(`Peer ${i} errors: ${data.errors.join('; ')}`);
    const last = data.samples.at(-1);
    const inbound = last.reports.flatMap(t => t.reports).filter(r => r.type === 'inbound-rtp');
    if (inbound.filter(r => r.kind === 'video' && r.framesDecoded > 0).length !== count - 1 || inbound.filter(r => r.kind === 'audio' && r.bytesReceived > 0).length !== count - 1) throw Error(`Peer ${i} missing decoded video or audio packets`);
  }
  checks.push({ name: 'every peer decoded remote video and received audio packets', passed: true });
  await pages[0].screenshot({ path: `artifacts/screenshots/${runId}.png`, fullPage: true });
  await pages.at(-1).getByRole('button', { name: 'Leave', exact: true }).click();
  await pages[0].waitForFunction(n => window.lab.consumers.size === (n - 2) * 2, count, { timeout: 15000 });
  checks.push({ name: 'remote tracks cleaned up after participant leaves', passed: true });
  if (errors.length) throw Error('Browser errors recorded');
  passed = true;
} catch (error) {
  errors.push({ message: error.stack });
  for (let i = 0; i < pages.length; i++) {
    try { await writeFile(`${folder}/peer-${i}-failure.json`, JSON.stringify(await pages[i].evaluate(() => window.lab.export()), null, 2)); } catch {}
  }
  try { await pages[0]?.screenshot({ path: `artifacts/screenshots/${runId}-failure.png`, fullPage: true }); } catch {}
} finally {
  let gitCommit;
  try { gitCommit = execFileSync('git', ['rev-parse','HEAD'], { encoding: 'utf8' }).trim(); } catch { gitCommit = null; }
  const workingTree = execFileSync('git', ['status','--porcelain'], { encoding: 'utf8' }).trim();
  await writeFile(`${folder}/manifest.json`, JSON.stringify({ runId, passed, checks, errors, mode, participants: count, measurementSeconds: seconds, browser: browser.version(), browserChannel: process.env.BROWSER_CHANNEL || 'chromium', platform: process.platform, node: process.version, gitCommit, workingTree, synthetic: true, impairment: 'none', limitations: ['All browsers and SFU on one Windows laptop', 'Synthetic canvas and tone; no real camera/microphone or human quality ratings', 'No mouth-to-ear measurement; no WAN, TURN, or network shaping', 'Join duration is application setup time, not time to first received media'] }, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ runId, passed, checks, errors }, null, 2));
if (!passed) process.exitCode = 1;
