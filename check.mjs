// Beerdome-bewaking: controleert of de winkel bereikbaar is en of afrekenen werkt.
// Stuurt een pushmelding via ntfy bij een storing en bij herstel. Geen afhankelijkheden (Node 20+).
//
// Rollen (--rol):
//   hoofd   = mini-pc thuis (Taakplanner, elke 10 min). Thuis-IP, dus geen SiteGround-botcontrole.
//   reserve = GitHub Actions. Controleert alleen zelf als de mini-pc al een tijd niets van zich laat horen.
// Beide sturen een hartslag naar een apart ntfy-topic (<topic>-hartslag, niet geabonneerd op de telefoon).
// Daarmee weten ze van elkaar of er echt gecontroleerd is: geen dubbele meldingen, en wel een melding
// "bewaking is blind" als er uren geen echte controle is gelukt.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const SITE = process.env.SITE || 'https://www.beerdome.nl';
const TOPIC = process.env.NTFY_TOPIC;          // geheime topicnaam (GitHub-secret / bestand op de mini-pc)
const HARTSLAG = TOPIC && `${TOPIC}-hartslag`;
const STATE = process.env.STATE || 'state/status.json';
const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const ROL = arg('--rol') || 'reserve';
const BRON = ROL === 'hoofd' ? 'minipc' : 'github';
const DRY = process.argv.includes('--droog');  // testen zonder pushmelding en zonder hartslag
const NABOOTSEN = process.env.NABOOTSEN;       // test: 'botcontrole' = doen alsof SiteGround elke keer 202 geeft
const MIN = 60e3, UUR = 3600e3;
const T = {
  blind: (Number(process.env.BLIND_UUR) || 3) * UUR,   // zo lang geen echte controle → "bewaking is blind"
  blindHerhaal: 6 * UUR,
  hoofdStil: 45 * MIN,       // reserve neemt over als de mini-pc zo lang geen controle meldt
  hartslagElke: 25 * MIN,    // niet elke run een hartslag: spaart de ntfy-limiet
  reserveLeeftElke: 2 * UUR,
  reserveStil: 8 * UUR,      // mini-pc meldt het als GitHub zo lang niets van zich laat horen
  reserveStilHerhaal: 24 * UUR,
};
const tijd = ms => new Date(ms).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// gewone browser-UA: SiteGround geeft afwijkende UA's vanaf datacenter-IP's eerder een botcontrole
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const BROWSER = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8' };

async function get(url, opts = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30000);
  try { return await fetch(url, { ...opts, signal: ctl.signal, headers: { ...BROWSER, ...(opts.headers || {}) } }); }
  finally { clearTimeout(t); }
}

// SiteGround geeft datacenter-IP's (zoals GitHub) soms een botcontrole: HTTP 202 + sgcaptcha.
// Echte bezoekers zien die niet; dat is dus geen storing, alleen "nu niet te controleren".
class BotControle extends Error {}
function botCheck(naam, r) {
  if (NABOOTSEN === 'botcontrole') throw new BotControle(`${naam}: botcontrole (nagebootst)`);
  if (r.status === 202) { console.log(`${naam} 202-headers:`, JSON.stringify(Object.fromEntries(r.headers))); throw new BotControle(`${naam}: botcontrole SiteGround (HTTP 202)`); }
}

async function pagina(naam, url, moetBevatten, cookie) {
  const r = await get(url, cookie ? { headers: { Cookie: cookie } } : {});
  botCheck(naam, r);
  if (r.status !== 200) throw new Error(`${naam}: HTTP ${r.status}`);
  const html = await r.text();
  if (!html.includes(moetBevatten)) throw new Error(`${naam}: pagina laadt, maar "${moetBevatten}" ontbreekt`);
}

async function winkelwagen() {
  const pr = await get(`${SITE}/wp-json/wc/store/v1/products?per_page=20&stock_status=instock&type=simple`);
  botCheck('Winkel-API', pr);
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

// geeft { fouten, gecontroleerd }: gecontroleerd = minstens één onderdeel echt nagelopen (geen botcontrole)
async function rondje() {
  const fouten = []; let gecontroleerd = false;
  for (const [naam, fn] of [
    ['Homepage', () => pagina('Homepage', `${SITE}/nl/`, 'Beerdome')],
    ['Winkelwagen en afrekenen', winkelwagen],
  ]) {
    try { await fn(); gecontroleerd = true; }
    catch (e) {
      if (e instanceof BotControle) { console.log(e.message); continue; }
      gecontroleerd = true;
      fouten.push(e.name === 'AbortError' ? `${naam}: geen antwoord binnen 30 s`
        : e.message === 'fetch failed' ? `${naam}: site niet bereikbaar (${e.cause?.code || e.cause?.message || 'geen verbinding'})` : e.message);
    }
  }
  return { fouten, gecontroleerd };
}

// eigen internet weg (mini-pc thuis)? Dan is een mislukte controle geen storing van de winkel.
async function internetOk() {
  if (NABOOTSEN === 'geen-internet') return false;
  for (const u of ['https://ntfy.sh/v1/health', 'https://www.google.com/generate_204']) {
    try { const r = await fetch(u, { signal: AbortSignal.timeout(10000) }); if (r.status < 500) return true; } catch {}
  }
  return false;
}

async function push(titel, tekst, prio, tags) {
  console.log(`PUSH [${prio}] ${titel}: ${tekst}`);
  if (DRY || !TOPIC) return;
  await fetch(`https://ntfy.sh/${TOPIC}`, { method: 'POST', body: tekst,
    headers: { Title: titel, Priority: prio, Tags: tags, Click: SITE } }).catch(e => console.log('push mislukt:', e.message));
}

// --- hartslag (apart topic, alleen voor de bewaking zelf) ---
async function hartslagLezen() {
  if (!HARTSLAG) return [];
  try {
    const r = await fetch(`https://ntfy.sh/${HARTSLAG}/json?poll=1&since=all`, { signal: AbortSignal.timeout(15000) });
    const regels = (await r.text()).split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(m => m.event === 'message');
    return regels.map(m => { try { return { ...JSON.parse(m.message), tijd: m.time * 1000 }; } catch { return null; } }).filter(Boolean);
  } catch (e) { console.log('hartslag lezen mislukt:', e.message); return null; }
}
async function hartslag(soort, extra = {}) {
  console.log(`HARTSLAG ${soort} (${BRON})`);
  if (DRY || !HARTSLAG) return;
  await fetch(`https://ntfy.sh/${HARTSLAG}`, { method: 'POST', body: JSON.stringify({ soort, bron: BRON, ...extra }) })
    .catch(e => console.log('hartslag sturen mislukt:', e.message));
}
const laatste = (lijst, f) => Math.max(0, ...lijst.filter(f).map(m => m.tijd));

// --- start ---
mkdirSync(STATE.replace(/[\\/][^\\/]*$/, ''), { recursive: true });
const vorig = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { stuk: false };
const st = { ...vorig, eersteRun: vorig.eersteRun || new Date().toISOString() };
const bewaarStatus = () => writeFileSync(STATE, JSON.stringify(st, null, 2));
const nu = Date.now();
const weekbericht = process.argv.includes('--weekbericht');
let hs = await hartslagLezen();
const hsOk = hs !== null; hs = hs || [];
const laatsteHoofd = laatste(hs, m => m.soort === 'controle' && m.bron === 'minipc');
const laatsteEcht = laatste(hs, m => m.soort === 'controle');

// Reserve: mini-pc draait → niets doen, alleen af en toe laten weten dat de reserve leeft.
if (ROL === 'reserve' && nu - laatsteHoofd < T.hoofdStil) {
  console.log(`Mini-pc controleerde ${Math.round((nu - laatsteHoofd) / MIN)} min geleden; reserve doet niets.`);
  if (st.hoofdStilGemeld) { await push('Beerdome-bewaking: mini-pc controleert weer', 'GitHub is weer alleen reserve.', 'low', 'house'); st.hoofdStilGemeld = null; }
  if (nu - laatste(hs, m => m.bron === 'github') > T.reserveLeeftElke) await hartslag('reserve-leeft');
  bewaarStatus(); process.exit(0);
}
if (ROL === 'reserve') console.log(hsOk ? `Geen recente controle van de mini-pc (laatste: ${laatsteHoofd ? tijd(laatsteHoofd) : 'onbekend'}); reserve controleert zelf.` : 'Hartslag niet te lezen; reserve controleert zelf.');

let { fouten, gecontroleerd } = await rondje();
if (fouten.length) {                       // tweede poging na een minuut: geen melding bij een korte hik
  await new Promise(r => setTimeout(r, Number(process.env.WACHT_MS ?? 60000)));
  ({ fouten, gecontroleerd } = await rondje());
}
if (fouten.length && !(await internetOk())) {
  console.log(`Eigen internet lijkt weg; geen melding. (${fouten.join(' | ')})`);
  fouten = []; gecontroleerd = false;
}
const stuk = fouten.length > 0;
console.log(stuk ? `STORING: ${fouten.join(' | ')}` : gecontroleerd ? 'Alles werkt' : 'Niet kunnen controleren (botcontrole of geen internet)');

if (gecontroleerd) {
  const iso = new Date(nu).toISOString();
  if (stuk && !vorig.stuk) await push('Beerdome: storing', fouten.join('\n'), 'urgent', 'rotating_light');
  else if (stuk && vorig.stuk && nu - Date.parse(vorig.laatsteMelding) > 2 * UUR)
    await push('Beerdome: nog steeds storing', `Sinds ${tijd(Date.parse(vorig.sinds))}\n${fouten.join('\n')}`, 'high', 'warning');
  else if (!stuk && vorig.stuk) await push('Beerdome: weer in orde', 'De winkel en het afrekenen werken weer.', 'default', 'white_check_mark');
  const melding = (stuk && !vorig.stuk) || (stuk && nu - Date.parse(vorig.laatsteMelding || 0) > 2 * UUR);
  Object.assign(st, { stuk, fouten, gecontroleerd: iso,
    sinds: stuk ? (vorig.stuk ? vorig.sinds : iso) : null,
    laatsteMelding: melding ? iso : (stuk ? vorig.laatsteMelding : null) });

  if (stuk !== !!vorig.stuk || nu - laatste(hs, m => m.soort === 'controle' && m.bron === BRON) > T.hartslagElke) await hartslag('controle', { stuk });
  if (st.blindGemeld) { await push('Beerdome-bewaking ziet weer', `Er is weer echt gecontroleerd (${BRON === 'minipc' ? 'mini-pc' : 'GitHub'}).`, 'low', 'eyes'); st.blindGemeld = null; }

  // reserve controleert omdat de mini-pc stil is: één keer laten weten
  if (ROL === 'reserve' && hsOk && !st.hoofdStilGemeld) {
    await push('Beerdome-bewaking: mini-pc controleert niet', `Laatste controle van de mini-pc: ${laatsteHoofd ? tijd(laatsteHoofd) : 'langer dan 12 uur geleden'}. GitHub neemt het over (stroom, internet of pc thuis?).`, 'default', 'house');
    st.hoofdStilGemeld = iso;
  }
} else {
  // niets echt gecontroleerd: is er de laatste uren nergens (mini-pc of GitHub) een echte controle gelukt?
  const sindsEcht = laatsteEcht || Date.parse(st.gecontroleerd || st.eersteRun);
  const laatsteBlind = Math.max(laatste(hs, m => m.soort === 'blind-gemeld'), Date.parse(st.blindGemeld || 0));
  if (hsOk && nu - sindsEcht > T.blind && nu - laatsteBlind > T.blindHerhaal) {
    await push('Beerdome-bewaking is blind', `Sinds ${tijd(sindsEcht)} is er geen echte controle gelukt (${BRON === 'minipc' ? 'mini-pc' : 'GitHub'} kan nu niet controleren). Kijk zelf even of de winkel werkt.`, 'high', 'see_no_evil');
    await hartslag('blind-gemeld');
    st.blindGemeld = new Date(nu).toISOString();
  }
}

// Mini-pc: laat de reserve (GitHub) nog van zich horen?
if (ROL === 'hoofd' && hsOk) {
  const laatsteReserve = laatste(hs, m => m.bron === 'github');
  const draaitAl = nu - Date.parse(st.eersteRun);
  if (nu - laatsteReserve > T.reserveStil && draaitAl > T.reserveStil && nu - Date.parse(st.reserveStilGemeld || 0) > T.reserveStilHerhaal) {
    await push('Beerdome-bewaking: reserve stil', `GitHub (reserve) heeft al ${Math.round(T.reserveStil / UUR)}+ uur niets laten horen. De mini-pc controleert gewoon door; kijk bij gelegenheid naar GitHub Actions / cron-job.org.`, 'low', 'zzz');
    st.reserveStilGemeld = new Date(nu).toISOString();
  } else if (nu - laatsteReserve <= T.reserveStil) st.reserveStilGemeld = null;
}

if (weekbericht && gecontroleerd && !stuk) {
  const reserve = laatste(hs, m => m.bron === 'github');
  await push('Beerdome-bewaking leeft', `Controle elke 10 minuten vanaf ${BRON === 'minipc' ? 'de mini-pc' : 'GitHub'}; alles werkt.` +
    (ROL === 'hoofd' ? `\nReserve (GitHub): ${reserve ? 'laatst ' + tijd(reserve) : 'geen teken van leven'}.` : ''), 'low', 'heartbeat');
}
bewaarStatus();
