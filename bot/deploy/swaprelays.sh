#!/usr/bin/env bash
# Ставит мост Netlify первым в /etc/di-sign-bot.env (Cloudflare соединяется нестабильно), перезапускает бота.
node -e '
const fs=require("fs");const f="/etc/di-sign-bot.env";
let t=fs.readFileSync(f,"utf8");
const get=(k)=>{const m=t.match(new RegExp("^"+k+"=(.*)$","m"));return m?m[1].replace(/^["\x27]|["\x27]$/g,""):null};
const r=get("TG_API_ROOT").split(","),k=get("TG_RELAY_KEY").split(",");
const ix=r.map((_,i)=>i).sort((a,b)=>(/netlify/.test(r[b])?1:0)-(/netlify/.test(r[a])?1:0));
const nr=ix.map(i=>r[i]).join(","),nk=(k.length>1?ix.map(i=>k[i]):k).join(",");
t=t.replace(/^TG_API_ROOT=.*$/m,"TG_API_ROOT="+nr).replace(/^TG_RELAY_KEY=.*$/m,"TG_RELAY_KEY="+nk);
fs.writeFileSync(f,t);console.log("порядок:",nr.replace(/https:\/\//g,""));'
systemctl restart di-sign-bot; sleep 8
systemctl is-active di-sign-bot
journalctl -u di-sign-bot --since "-20sec" --no-pager -o cat | tail -5
