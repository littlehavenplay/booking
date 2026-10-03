// GET /i/<id> — the party invitation guests open from a text or email.
// Rendered on the server so link previews in Messages / WhatsApp / Facebook show
// the child's name and a picture instead of a blank card.
import {
  THEMES, DEFAULT_THEME, themeArt, loadByInvite, esc, firstName, prettyDate, prettyTime, ordinal,
  defaultHeadline, photoUrl, ogImage, guestUrl, calendarUrl, MAPS_URL, STUDIO, STUDIO_ADDRESS, WAIVER_URL, SITE,
} from "./lib-invite.js";
import { CONSENT_TEXT } from "./lib-sms.js";

export default async (req) => {
  const url = new URL(req.url);
  const id = (url.pathname.split("/")[2] || "").toLowerCase();
  const preview = url.searchParams.has("preview");
  const found = await loadByInvite(id);
  if (!found) return html(notFound(), 404);
  return html(renderInvite(found.rec, { preview }));
};

export function renderInvite(rec, { preview = false } = {}) {
  const inv = rec.invite || {};
  const T = THEMES[inv.theme] || THEMES[DEFAULT_THEME];
  const themeId = THEMES[inv.theme] ? inv.theme : DEFAULT_THEME;
  const f = firstName(rec.childName) || "our birthday kid";
  const headline = inv.headline || defaultHeadline(rec, inv);
  const age = parseInt(inv.age, 10);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const past = rec.date && rec.date < today;
  const photo = photoUrl(inv);
  const title = `You're invited to ${f}'s ${age > 0 ? ordinal(age) + " " : ""}birthday party!`;
  const desc = `${prettyDate(rec.date)}, ${prettyTime(rec.slotLabel)} at ${STUDIO}. Tap to RSVP.`;
  const cal = calendarUrl(rec, `${f}'s birthday party`);
  const rsvpBy = /^\d{4}-\d{2}-\d{2}$/.test(inv.rsvpBy || "") ? prettyDate(inv.rsvpBy) : "";
  const dark = themeId === "space";

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="noindex">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(ogImage(inv))}">
<meta property="og:url" content="${esc(guestUrl(inv))}">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="${T.bg}">
<link rel="icon" type="image/png" sizes="32x32" href="/assets/icons/favicon-32.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600&family=Nunito:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--bg:${T.bg};--card:${T.card};--ink:${T.ink};--soft:${T.soft};--accent:${T.accent};--accent-ink:${T.accentInk};--line:${T.line};
  --field:${dark ? "#1d2147" : "#ffffff"};--fieldline:${dark ? "#4a5196" : T.line};color-scheme:${dark ? "dark" : "light"}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-family:Nunito,system-ui,-apple-system,"Segoe UI",sans-serif;font-size:17px;line-height:1.55;padding:22px 16px 48px}
.wrap{max-width:480px;margin:0 auto}
.preview{background:#fff8d6;color:#5b4a12;border-radius:10px;padding:8px 12px;font-size:.85rem;font-weight:700;text-align:center;margin-bottom:14px}
.inv{position:relative;background:var(--card);border-radius:6px 6px 26px 26px;padding:0 24px 28px;text-align:center;
  box-shadow:0 18px 40px -26px rgba(40,25,10,.55)}
.inv::before{content:"";position:absolute;left:0;right:0;top:-11px;height:12px;
  background:radial-gradient(circle at 11px 12px,var(--card) 10.5px,transparent 11.5px) 0 0/22px 12px repeat-x}
.art{display:block;width:calc(100% + 48px);margin:0 -24px;height:auto}
.lead{margin:6px 0 10px;color:var(--soft);font-weight:700;font-size:1rem}
.photo{width:148px;height:148px;border-radius:50%;object-fit:cover;display:block;margin:4px auto 14px;border:5px solid var(--card);
  box-shadow:0 0 0 3px var(--accent)}
h1{font-family:Fredoka,Nunito,sans-serif;font-weight:600;font-size:clamp(2.1rem,9vw,2.75rem);line-height:1.05;margin:0 0 12px;color:var(--ink);letter-spacing:-.01em;text-wrap:balance}
.msg{margin:0 auto 18px;max-width:34ch;color:var(--soft);white-space:pre-line}
.facts{margin:6px 0 20px;padding:16px 0 0;border-top:2px dotted var(--line);display:grid;gap:12px;text-align:left}
.fact{display:grid;grid-template-columns:28px 1fr;gap:10px;align-items:start}
.fact svg{width:24px;height:24px;margin-top:2px;color:var(--accent)}
.fact b{display:block;font-weight:800}
.fact span{color:var(--soft);font-size:.95rem}
.fact a{color:var(--accent);font-weight:700}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:52px;padding:0 26px;border-radius:999px;border:0;
  background:var(--accent);color:var(--accent-ink);font:800 1.02rem Nunito,sans-serif;text-decoration:none;cursor:pointer}
.btn:focus-visible,.choice:focus-within,input:focus-visible,textarea:focus-visible,button:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.waiver-note{margin:10px 0 0;color:var(--soft);font-size:.88rem}
.rsvp{background:var(--card);border-radius:22px;padding:22px 20px 24px;margin-top:22px;box-shadow:0 18px 40px -30px rgba(40,25,10,.55)}
.rsvp h2{font-family:Fredoka,Nunito,sans-serif;font-weight:600;font-size:1.6rem;margin:0 0 4px}
.rsvp .by{margin:0 0 14px;color:var(--soft);font-size:.92rem}
.choices{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:6px 0 16px}
.choice{position:relative;border:2px solid var(--fieldline);border-radius:14px;padding:12px 10px;text-align:center;font-weight:800;cursor:pointer;background:var(--field)}
.choice input{position:absolute;opacity:0;inset:0;cursor:pointer}
.choice:has(input:checked){border-color:var(--accent);background:var(--accent);color:var(--accent-ink)}
label.f{display:block;font-weight:800;font-size:.9rem;margin:12px 0 5px}
label.f small{font-weight:600;color:var(--soft)}
input[type=text],input[type=tel],input[type=email],textarea{width:100%;font:inherit;font-size:16px;color:var(--ink);background:var(--field);border:1.5px solid var(--fieldline);border-radius:12px;padding:12px 13px}
textarea{min-height:76px;resize:vertical}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.kid{display:grid;grid-template-columns:1fr 44px;gap:8px;margin-bottom:8px}
.x{border:1.5px solid var(--fieldline);background:var(--field);color:var(--soft);border-radius:12px;font-size:1.3rem;cursor:pointer}
.link{background:none;border:0;color:var(--accent);font:800 .95rem Nunito,sans-serif;padding:6px 0;cursor:pointer}
.stepper{display:inline-grid;grid-template-columns:48px 56px 48px;align-items:center;border:1.5px solid var(--fieldline);border-radius:12px;overflow:hidden;background:var(--field)}
.stepper button{height:46px;border:0;background:transparent;color:var(--ink);font-size:1.4rem;cursor:pointer}
.stepper output{text-align:center;font-weight:800;font-size:1.1rem}
.opt{display:grid;grid-template-columns:22px 1fr;gap:10px;margin:16px 0 4px;font-size:.8rem;color:var(--soft);line-height:1.45}
.opt input{width:20px;height:20px;margin:1px 0 0;accent-color:var(--accent)}
.opt b{color:var(--ink);font-size:.9rem}
.send{width:100%;margin-top:16px}
.err{display:none;margin-top:12px;background:#fde8e5;color:#9b2f25;border-radius:10px;padding:10px 12px;font-weight:700;font-size:.92rem}
.done{text-align:center}
.done h2{margin-top:4px}
.done p{color:var(--soft)}
.done .btn{margin:6px 4px}
.ghost{background:transparent;color:var(--accent);box-shadow:inset 0 0 0 2px var(--accent)}
.hidden{display:none!important}
footer{text-align:center;margin-top:26px;color:var(--soft);font-size:.86rem}
footer a{color:var(--accent);font-weight:800}
.past{color:var(--soft);text-align:center;margin:18px 0 0}
@media (prefers-reduced-motion:no-preference){.inv h1{animation:pop .7s cubic-bezier(.2,1.4,.4,1) both .1s}@keyframes pop{from{transform:scale(.85);opacity:0}to{transform:none;opacity:1}}}
</style>
</head><body>
<div class="wrap">
${preview ? `<div class="preview">Preview — this is what your guests will see.</div>` : ""}
<article class="inv">
  <svg class="art" viewBox="0 0 600 150" aria-hidden="true">${themeArt(themeId)}</svg>
  <p class="lead">You're invited to a birthday party</p>
  ${photo ? `<img class="photo" src="${esc(photo)}" alt="${esc(f)}">` : ""}
  <h1>${esc(headline)}</h1>
  ${inv.message ? `<p class="msg">${esc(inv.message)}</p>` : ""}
  <div class="facts">
    <div class="fact"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>
      <div><b>${esc(prettyDate(rec.date))}</b><span>${esc(prettyTime(rec.slotLabel))}${cal ? ` · <a href="${esc(cal)}" target="_blank" rel="noopener">Add to calendar</a>` : ""}</span></div></div>
    <div class="fact"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>
      <div><b>${esc(STUDIO)}</b><span>${esc(STUDIO_ADDRESS)} · <a href="${esc(MAPS_URL)}" target="_blank" rel="noopener">Directions</a></span></div></div>
    <div class="fact"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13l2 2 4-4"/></svg>
      <div><b>Waiver for every guest</b><span>Each child and adult needs one to play. Grip socks are required for kids.</span></div></div>
  </div>
  <a class="btn" href="${esc(WAIVER_URL)}" target="_blank" rel="noopener">Sign the waiver</a>
  <p class="waiver-note">Takes about a minute. Signing ahead means no line at the door.</p>
</article>

${past ? `<p class="past">This party has already happened. Thanks for celebrating with us!</p>` : `
<section class="rsvp" id="rsvp" aria-labelledby="rsvpTitle">
  <form id="rf" novalidate>
    <h2 id="rsvpTitle">RSVP</h2>
    <p class="by">${rsvpBy ? `Please let ${esc(f)}'s family know by ${esc(rsvpBy)}.` : `Let ${esc(f)}'s family know if you can come.`}</p>
    <div class="choices" role="radiogroup" aria-label="Will you be there?">
      <label class="choice"><input type="radio" name="att" value="yes" checked> We'll be there</label>
      <label class="choice"><input type="radio" name="att" value="no"> Can't make it</label>
    </div>
    <label class="f" for="nm">Your name</label>
    <input type="text" id="nm" autocomplete="name" required>
    <div class="row2">
      <div><label class="f" for="ph">Mobile <small>(optional)</small></label><input type="tel" id="ph" autocomplete="tel" inputmode="tel"></div>
      <div><label class="f" for="em">Email <small>(optional)</small></label><input type="email" id="em" autocomplete="email"></div>
    </div>
    <div id="coming">
      <label class="f">Children coming</label>
      <div id="kids"></div>
      <button type="button" class="link" id="addKid">+ Add another child</button>
      <label class="f" for="adOut">Adults coming</label>
      <div class="stepper"><button type="button" id="adMinus" aria-label="One fewer adult">−</button><output id="adOut" aria-live="polite">1</output><button type="button" id="adPlus" aria-label="One more adult">+</button></div>
    </div>
    <label class="f" for="nt">Note for the family <small>(optional)</small></label>
    <textarea id="nt" maxlength="300" placeholder="Allergies, running late, anything they should know"></textarea>
    <input type="text" name="website" id="hp" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">
    <label class="opt"><input type="checkbox" id="sms"><span><b>Text me Little Haven events &amp; deals</b><br>${esc(CONSENT_TEXT.replace(/^Yes, text me Little Haven Play Studio news, events & deals\. /, ""))} <a href="${SITE}/terms.html#privacy" target="_blank" rel="noopener" style="color:var(--accent)">Terms &amp; privacy</a></span></label>
    <button class="btn send" type="submit" id="go"${preview ? " disabled" : ""}>${preview ? "RSVP (turned off in preview)" : "Send RSVP"}</button>
    <div class="err" id="er" role="alert"></div>
  </form>
  <div class="done hidden" id="dn" aria-live="polite">
    <h2 id="dnT"></h2>
    <p id="dnP"></p>
    <a class="btn" href="${esc(WAIVER_URL)}" target="_blank" rel="noopener" id="dnW">Sign the waiver</a>
    ${cal ? `<a class="btn ghost" href="${esc(cal)}" target="_blank" rel="noopener" id="dnC">Add to calendar</a>` : ""}
    <p><button type="button" class="link" id="edit">Change my RSVP</button></p>
  </div>
</section>`}

<footer>Celebrating at <a href="${SITE}/" target="_blank" rel="noopener">${esc(STUDIO)}</a>.<br>Planning your own? <a href="${SITE}/parties.html" target="_blank" rel="noopener">See party packages</a></footer>
</div>
${past ? "" : `<script>
(function(){
  var ID=${JSON.stringify(rec.invite.id)}, CHILD=${JSON.stringify(f)}, PREVIEW=${preview ? "true" : "false"};
  var $=function(s){return document.getElementById(s);};
  var LS="lh_rsvp_"+ID, saved=null; try{ saved=JSON.parse(localStorage.getItem(LS)||"null"); }catch(e){}
  var adults=1;
  function kidRow(v){ var d=document.createElement("div"); d.className="kid";
    d.innerHTML='<input type="text" class="kn" aria-label="Child\\'s name" placeholder="Child\\'s name" autocomplete="off"><button type="button" class="x" aria-label="Remove this child">×</button>';
    d.querySelector("input").value=v||""; d.querySelector("button").onclick=function(){ if(document.querySelectorAll(".kid").length>1) d.remove(); else d.querySelector("input").value=""; };
    $("kids").appendChild(d); return d; }
  function setAdults(n){ adults=Math.max(0,Math.min(10,n)); $("adOut").textContent=adults; }
  $("adMinus").onclick=function(){ setAdults(adults-1); }; $("adPlus").onclick=function(){ setAdults(adults+1); };
  $("addKid").onclick=function(){ kidRow("").querySelector("input").focus(); };
  function att(){ var c=document.querySelector('input[name=att]:checked'); return c?c.value:"yes"; }
  function sync(){ $("coming").classList.toggle("hidden", att()==="no"); }
  Array.prototype.forEach.call(document.querySelectorAll('input[name=att]'),function(r){ r.onchange=sync; });
  function fill(d){
    $("kids").innerHTML=""; (d&&d.kids&&d.kids.length?d.kids:[""]).forEach(kidRow);
    if(d){ $("nm").value=d.name||""; $("ph").value=d.phone||""; $("em").value=d.email||""; $("nt").value=d.note||"";
      setAdults(typeof d.adults==="number"?d.adults:1);
      var r=document.querySelector('input[name=att][value="'+(d.attending==="no"?"no":"yes")+'"]'); if(r) r.checked=true; }
    sync();
  }
  function showDone(d,updated){
    $("rf").classList.add("hidden"); $("dn").classList.remove("hidden");
    var yes=d.attending!=="no";
    $("dnT").textContent=yes?(updated?"RSVP updated":"See you there!"):"Thanks for letting them know";
    $("dnP").textContent=yes?("You're on "+CHILD+"'s guest list. One last thing: please sign the waiver before the party."):("We've let "+CHILD+"'s family know you can't make it.");
    $("dnW").classList.toggle("hidden",!yes); if($("dnC")) $("dnC").classList.toggle("hidden",!yes);
  }
  $("edit").onclick=function(){ $("dn").classList.add("hidden"); $("rf").classList.remove("hidden"); };
  fill(saved&&saved.data);
  if(saved&&saved.rsvpId&&!PREVIEW) showDone(saved.data,false);
  $("rf").onsubmit=async function(e){
    e.preventDefault(); if(PREVIEW) return;
    var er=$("er"); er.style.display="none";
    var d={attending:att(),name:$("nm").value.trim(),phone:$("ph").value.trim(),email:$("em").value.trim(),note:$("nt").value.trim(),
      kids:Array.prototype.map.call(document.querySelectorAll(".kn"),function(i){return i.value.trim();}).filter(Boolean),adults:adults};
    function bad(m,el){ er.textContent=m; er.style.display="block"; if(el) el.focus(); }
    if(!d.name) return bad("Please enter your name.",$("nm"));
    if(d.phone.replace(/\\D/g,"").length<10 && !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(d.email)) return bad("Please add a mobile number or an email so the family can reach you.",$("ph"));
    if(d.attending==="yes" && !d.kids.length) return bad("Please add the name of each child coming.",document.querySelector(".kn"));
    var go=$("go"); go.disabled=true; go.textContent="Sending…";
    try{
      var body=Object.assign({action:"rsvp",i:ID,smsOptIn:$("sms").checked,website:$("hp").value},d);
      if(saved&&saved.rsvpId){ body.rsvpId=saved.rsvpId; body.editKey=saved.editKey; }
      var r=await (await fetch("/api/invite",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)})).json();
      if(r&&r.ok){ saved={rsvpId:r.rsvpId,editKey:r.editKey,data:d}; try{ localStorage.setItem(LS,JSON.stringify(saved)); }catch(e){} showDone(d,r.updated); }
      else bad((r&&r.error)||"Couldn't send your RSVP. Please try again.");
    }catch(e){ bad("No connection. Check your signal and try again."); }
    go.disabled=false; go.textContent="Send RSVP";
  };
})();
</script>`}
</body></html>`;
}

function notFound() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Invitation not found · ${esc(STUDIO)}</title><meta name="robots" content="noindex">
<style>body{margin:0;background:#fdf1ec;color:#4a3526;font-family:Nunito,system-ui,sans-serif;padding:60px 16px;text-align:center}a{color:#a85f59;font-weight:800}</style>
</head><body><h1 style="font-weight:700;font-size:1.5rem">We couldn't find that invitation</h1>
<p>The party may have changed. Please check the link with the family who invited you.</p>
<p><a href="${SITE}/">Little Haven Play Studio</a></p></body></html>`;
}

function html(body, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
export const config = { path: "/i/*" };
