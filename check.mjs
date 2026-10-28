// Beerdome-bewaking: controleert of de winkel bereikbaar is en of afrekenen werkt.
// Stuurt een pushmelding via ntfy bij een storing en bij herstel. Geen afhankelijkheden (Node 20+).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const SITE = process.env.SITE || 'https://www.beerdome.nl';
const TOPIC = process.env.NTFY_TOPIC;          // geheime topicnaam, als GitHub-secret
const STATE = 'state/status.json';
const DRY = process.argv.includes('--droog');  // lokaal testen zonder pushmelding
const UA = 'Mozilla/5.0 (Beerdome-bewaking; +https://www.beerdome.nl)';

async function get(url, opts = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30000);
  try { return await fetch(url, { ...opts, signal: ctl.signal, headers: { 'User-Agent': UA, ...(opts.headers || {}) } }); }
  finally { clearTimeout(t); }
}

async function pagina(naam, url, moetBevatten, cookie) {
  const r = await get(url, cookie ? { headers: { Cookie: cookie } } : {});
  if (r.status !== 200) throw new Error(`${naam}: HTTP ${r.status}`);
  const html = await r.text();
  if (!html.includes(moetBevatten)) throw new Error(`${naam}: pagina laadt, maar "${moetBevatten}" ontbreekt`);
}

async function winkelwagen() {
  const pr = await get(`${SITE}/wp-json/wc/store/v1/products?per_page=20&stock_status=instock&type=simple`);
  const prods = await pr.json().catch(() => { throw new Error(`Winkel-API geeft geen productlijst (HTTP ${pr.status})`); });
  const prod = Array.isArray(prods) && prods.find(p => p.is_purchasable && p.add_to_cart?.minimum <= 1);
  if (!prod) throw new Error('Winkel-API: geen koopbaar product gevonden');
  // eerst een gewone pagina: die zet het sessiecookie, net als bij een echte bezoeker
  const jar = new Map();
  const bewaar = r => r.headers.getSetCookie().forEach(x => { const [kv] = x.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); });
  const koek = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  bewaar(await get(`${SITE}/nl/winkelwagen/`));
  const c = await get(`${SITE}/wp-json/wc/store/v1/cart`, { headers: { Cookie: koek() } }); bewaar(c);
  const nonce = c.headers.get('nonce');
  if (c.status !== 200 || !nonce) throw new Error(`Winkelwagen ophalen: HTTP ${c.status}`);
  const a = await get(`${SITE}/wp-json/wc/store/v1/cart/add-item`, {
    method: 'POST', body: JSON.stringify({ id: prod.id, quantity: 1 }),
    headers: { 'Content-Type': 'application/json', Nonce: nonce, Cookie: koek() },
  });
  bewaar(a);
  const j = await a.json().catch(() => ({}));
  if (a.status !== 201 || j.items_count < 1) throw new Error(`In winkelwagen leggen mislukt: HTTP ${a.status} ${j.message || ''}`.trim());
  if (!j.payment_methods?.length) throw new Error('Winkelwagen werkt, maar er zijn geen betaalmethodes');
  // afrekenpagina in dezelfde sessie (met lege winkelwagen stuurt WooCommerce door)
  await pagina('Afrekenpagina', `${SITE}/nl/afrekenen/`, 'wp-block-woocommerce-checkout', koek());
}

async function rondje() {
  const fouten = [];
  for (const [naam, fn] of [
    ['Homepage', () => pagina('Homepage', `${SITE}/nl/`, 'Beerdome')],
    ['Winkelwagen en afrekenen', winkelwagen],
  ]) {
    try { await fn(); } catch (e) { fouten.push(e.name === 'AbortError' ? `${naam}: geen antwoord binnen 30 s` : e.message); }
  }
  return fouten;
}

async function push(titel, tekst, prio, tags) {
  console.log(`PUSH [${prio}] ${titel}: ${tekst}`);
  if (DRY || !TOPIC) return;
  await fetch(`https://ntfy.sh/${TOPIC}`, { method: 'POST', body: tekst,
    headers: { Title: titel, Priority: prio, Tags: tags, Click: SITE } });
}

const vorig = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { stuk: false };
let fouten = await rondje();
if (fouten.length) {                       // tweede poging na een minuut: geen melding bij een korte hik
  await new Promise(r => setTimeout(r, 60000));
  fouten = await rondje();
}
const nu = new Date().toISOString();
const stuk = fouten.length > 0;
console.log(stuk ? `STORING: ${fouten.join(' | ')}` : 'Alles werkt');

if (stuk && !vorig.stuk) await push('Beerdome: storing', fouten.join('\n'), 'urgent', 'rotating_light');
else if (stuk && vorig.stuk && Date.now() - Date.parse(vorig.laatsteMelding) > 2 * 3600e3)
  await push('Beerdome: nog steeds storing', `Sinds ${new Date(vorig.sinds).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' })}\n${fouten.join('\n')}`, 'high', 'warning');
else if (!stuk && vorig.stuk) await push('Beerdome: weer in orde', 'De winkel en het afrekenen werken weer.', 'default', 'white_check_mark');

const weekbericht = process.argv.includes('--weekbericht');
if (weekbericht && !stuk) await push('Beerdome-bewaking leeft', 'Controle elke 10 minuten; alles werkt.', 'low', 'heartbeat');

const melding = (stuk && !vorig.stuk) || (stuk && Date.now() - Date.parse(vorig.laatsteMelding || 0) > 2 * 3600e3);
writeFileSync(STATE, JSON.stringify({
  stuk, fouten, gecontroleerd: nu,
  sinds: stuk ? (vorig.stuk ? vorig.sinds : nu) : null,
  laatsteMelding: melding ? nu : (stuk ? vorig.laatsteMelding : null),
}, null, 2));
